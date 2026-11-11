import Foundation

/// Album and artist pages kept on the device, the last 40 opened (App.jsx keepPage), so a page
/// seen before paints at once, also offline, and refreshes behind.
/// TODO(lead): one shared page cache for every detail screen (6.0.15).
@MainActor
final class DetailCache {
    static let shared = DetailCache()
    static let limit = 40

    private let dir: URL
    private var memory: [String: Data] = [:]

    init(dir: URL? = nil) {
        self.dir = dir ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("detail-pages", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true)
    }

    /// `key` like "al.<id>"; `scope` keeps accounts apart.
    func load<T: Decodable>(_ key: String, scope: String?, as: T.Type = T.self) -> T? {
        let k = name(key, scope)
        let data = memory[k] ?? (try? Data(contentsOf: dir.appendingPathComponent(k)))
        guard let data else { return nil }
        memory[k] = data
        return try? JSONDecoder().decode(T.self, from: data)
    }

    func save<T: Encodable>(_ value: T, _ key: String, scope: String?) {
        let k = name(key, scope)
        guard let data = try? JSONEncoder().encode(value) else { return }
        memory[k] = data
        try? data.write(to: dir.appendingPathComponent(k), options: .atomic)
        trim()
    }

    private func name(_ key: String, _ scope: String?) -> String {
        let safe = (scope ?? "anon") + "." + key
        return safe.replacingOccurrences(of: "/", with: "_") + ".json"
    }

    /// Oldest written first out.
    private func trim() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]),
              files.count > Self.limit else { return }
        let dated = files.map { f in (f, (try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        for (f, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - Self.limit) {
            try? fm.removeItem(at: f)
            memory[f.lastPathComponent] = nil
        }
    }
}

/// What an artist page keeps (App.jsx `ar.<id>`): the artist, its tracks in popular order, albums.
struct DetailArtistPage: Codable {
    var detail: ArtistDetail
    var popular: [String]?
}
