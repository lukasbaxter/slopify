import Foundation

/// What the home screen widgets show. The app writes it into the shared app-group folder
/// (with the cover files beside it); the widget extension only reads.
struct WidgetSnapshot: Codable, Equatable, Sendable {
    struct Now: Codable, Equatable, Sendable {
        var id: String
        var title: String
        var artist: String
        /// File name in the shared covers folder; nil until the picture is there.
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

/// The shared folder. Everything is a no-op (nil) where the app group is not available.
enum WidgetStore {
    /// `group.<app bundle id>`, from the Info.plist of whichever target is running.
    static var group: String? { Bundle.main.object(forInfoDictionaryKey: "SlopifyAppGroup") as? String }

    static var folder: URL? {
        guard let group, !group.isEmpty else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("widgets", isDirectory: true)
    }

    static var covers: URL? { folder?.appendingPathComponent("covers", isDirectory: true) }
    private static var file: URL? { folder?.appendingPathComponent("snapshot.json") }

    static func read() -> WidgetSnapshot? {
        guard let file, let d = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: d)
    }

    @discardableResult
    static func write(_ s: WidgetSnapshot) -> Bool {
        guard let folder, let file, let d = try? JSONEncoder().encode(s) else { return false }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return (try? d.write(to: file, options: .atomic)) != nil
    }

    static func coverFile(_ name: String?) -> URL? {
        guard let name, let covers else { return nil }
        return covers.appendingPathComponent(name)
    }
}
