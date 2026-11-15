import Foundation
import Security

/// What the home screen widgets show. The app writes it (and the covers) where the widget
/// extension can read it: see `WidgetStore`.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    struct Now: Codable, Equatable, Sendable {
        var id: String
        var title: String
        var artist: String
        /// The cover's name in `WidgetStore`; nil until the picture is there.
        var cover: String?
        /// Background colour taken from the cover, 0...255 channels.
        var tint: [Int]?
        var playing: Bool
        /// The playhead at `at`, seconds.
        var position: Double
        var duration: Double
        var at: Date
    }

    /// One of the listener's recent shortcuts (Home's top grid).
    struct Tile: Codable, Equatable, Sendable {
        var link: String
        var title: String
        var cover: String?
        /// Artists are circles, everywhere.
        var round: Bool
    }

    var now: Now?
    var recents: [Tile] = []
}

/// Where a tap on a widget leads in the app.
enum WidgetLink: Equatable, Sendable {
    case nowPlaying
    case album(String)
    case playlist(String)
    case artist(String)
    case radio(seedId: String, name: String?)

    static let scheme = "slopify-widget"

    var url: URL {
        var c = URLComponents()
        c.scheme = Self.scheme
        switch self {
        case .nowPlaying: c.host = "now"
        case .album(let id): c.host = "album"; c.path = "/" + id
        case .playlist(let id): c.host = "playlist"; c.path = "/" + id
        case .artist(let id): c.host = "artist"; c.path = "/" + id
        case .radio(let id, let name):
            c.host = "radio"; c.path = "/" + id
            if let name, !name.isEmpty { c.queryItems = [URLQueryItem(name: "name", value: name)] }
        }
        return c.url ?? URL(string: Self.scheme + "://now")!
    }

    init?(_ url: URL) {
        guard url.scheme == Self.scheme, let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let id = String(c.path.dropFirst())
        switch c.host {
        case "now": self = .nowPlaying
        case "album" where !id.isEmpty: self = .album(id)
        case "playlist" where !id.isEmpty: self = .playlist(id)
        case "artist" where !id.isEmpty: self = .artist(id)
        case "radio" where !id.isEmpty: self = .radio(seedId: id, name: c.queryItems?.first { $0.name == "name" }?.value)
        default: return nil
        }
    }
}

/// Pure widget rules.
enum WidgetLogic {
    /// Tiles under the player in the medium widget.
    static let tileCount = 4

    /// The span the progress line runs over, from the playhead it was told about. Nil when
    /// nothing moves (paused, no length, or the song would already be over).
    static func progressSpan(_ now: WidgetSnapshot.Now, at date: Date) -> ClosedRange<Date>? {
        guard now.playing, now.duration > 0 else { return nil }
        let start = now.at.addingTimeInterval(-now.position)
        let end = start.addingTimeInterval(now.duration)
        return end > date ? start...end : nil
    }

    /// Where the playhead should be at `date`, going by what was last written.
    static func expectedPosition(_ now: WidgetSnapshot.Now, at date: Date) -> Double {
        guard now.playing else { return now.position }
        return min(max(0, now.position + date.timeIntervalSince(now.at)), max(now.duration, now.position))
    }

    /// Whether the widgets have to be redrawn for `new`. The playhead alone moving as
    /// predicted is not a reason: the progress line runs by itself.
    static func differs(_ old: WidgetSnapshot.Now?, _ new: WidgetSnapshot.Now?) -> Bool {
        guard let old, let new else { return (old == nil) != (new == nil) }
        if old.id != new.id || old.title != new.title || old.artist != new.artist || old.playing != new.playing
            || old.cover != new.cover || old.tint != new.tint || abs(old.duration - new.duration) > 1 { return true }
        return abs(expectedPosition(old, at: new.at) - new.position) > 3
    }
}

/// Where the app leaves the snapshot and the covers for the widget extension: a keychain
/// access group the two share. (An App Group folder would be the usual place, but it needs
/// its own provisioning; a shared keychain group comes with every team profile.)
/// Everything is a no-op (nil / false) where the group is not available.
enum WidgetStore {
    /// `<team prefix><shared id>`, from the Info.plist of whichever target is running.
    static var group: String? {
        let g = Bundle.main.object(forInfoDictionaryKey: "SlopifyKeychainGroup") as? String
        return g?.isEmpty == false ? g : nil
    }

    private static let service = "slopify.widget"
    private static let snapshotKey = "snapshot"
    private static let coverPrefix = "cover:"

    private static func query(_ account: String?) -> [String: Any]? {
        guard let group else { return nil }
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccessGroup as String: group]
        if let account { q[kSecAttrAccount as String] = account }
        return q
    }

    private static func get(_ account: String) -> Data? {
        guard var q = query(account) else { return nil }
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    private static func set(_ account: String, _ data: Data) -> Bool {
        guard let q = query(account) else { return false }
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = q
        add[kSecValueData as String] = data
        // The widget is redrawn while the phone is locked too.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func read() -> WidgetSnapshot? {
        guard let d = get(snapshotKey) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: d)
    }

    @discardableResult
    static func write(_ s: WidgetSnapshot) -> Bool {
        guard let d = try? JSONEncoder().encode(s) else { return false }
        return set(snapshotKey, d)
    }

    static func cover(_ name: String?) -> Data? {
        guard let name else { return nil }
        return get(coverPrefix + name)
    }

    static func hasCover(_ name: String) -> Bool {
        guard var q = query(coverPrefix + name) else { return false }
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        return SecItemCopyMatching(q as CFDictionary, nil) == errSecSuccess
    }

    static func saveCover(_ name: String, _ data: Data) -> Bool { set(coverPrefix + name, data) }

    /// Drops every stored cover the snapshot no longer shows.
    static func sweep(keeping: Set<String>) {
        guard var q = query(nil) else { return }
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String, account.hasPrefix(coverPrefix),
                  !keeping.contains(String(account.dropFirst(coverPrefix.count))), let del = query(account) else { continue }
            SecItemDelete(del as CFDictionary)
        }
    }
}
