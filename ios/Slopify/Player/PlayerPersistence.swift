import Foundation

/// Queue + playhead on disk, so a relaunch shows the last song paused (web `saveQueue` /
/// `savePlayhead`). Two files: the queue (big, written when it changes) and the playhead
/// (tiny, written every few seconds while playing, on pause and on backgrounding).
struct PlayerPersistence {
    struct Playhead: Codable, Equatable {
        var trackId: String
        var index: Int
        var position: Double
        var repeatMode: Player.Repeat
        var shuffle: Player.Shuffle
        var volume: Double?
        /// Epoch ms written. Compared with the server session's `at` (§20.4).
        var at: Double
    }

    struct Saved: Equatable {
        var queue: PlayQueue
        var position: Double
        var volume: Double?
        var at: Double
    }

    let dir: URL
    /// Serial, so two writes of one file never land out of order.
    private static let io = DispatchQueue(label: "slopify.player.persist", qos: .utility)

    /// One folder per signed-in account + server so another account never sees this queue.
    static func forAccount(_ key: String) -> PlayerPersistence {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let safe = key.map { $0.isLetter || $0.isNumber ? $0 : "_" }
        return PlayerPersistence(dir: base.appendingPathComponent("player", isDirectory: true).appendingPathComponent(String(safe), isDirectory: true))
    }

    private var queueURL: URL { dir.appendingPathComponent("queue.json") }
    private var headURL: URL { dir.appendingPathComponent("playhead.json") }

    func saveQueue(_ q: PlayQueue) {
        guard !q.isEmpty else { return }
        let data = try? JSONEncoder().encode(q)
        write(data, to: queueURL)
    }

    func savePlayhead(_ h: Playhead) {
        write(try? JSONEncoder().encode(h), to: headURL)
    }

    func load() -> Saved? {
        guard let qd = try? Data(contentsOf: queueURL), var q = try? JSONDecoder().decode(PlayQueue.self, from: qd), !q.isEmpty else { return nil }
        let head = (try? Data(contentsOf: headURL)).flatMap { try? JSONDecoder().decode(Playhead.self, from: $0) }
        // Prefer the track id over the index (web restore).
        if let h = head {
            let i = q.entries.firstIndex { $0.track.id == h.trackId } ?? min(max(0, h.index), q.entries.count - 1)
            q.index = i
            q.repeatMode = h.repeatMode
            q.shuffle = h.shuffle
        }
        q.index = min(max(0, q.index), q.entries.count - 1)
        let dur = q.current?.track.duration ?? 0
        let pos = max(0, min(head?.position ?? 0, dur > 0 ? dur : (head?.position ?? 0)))
        return Saved(queue: q, position: pos, volume: head?.volume, at: head?.at ?? 0)
    }

    func clear() { try? FileManager.default.removeItem(at: dir) }

    private func write(_ data: Data?, to url: URL) {
        guard let data else { return }
        let dir = self.dir
        Self.io.async {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    /// Synchronous write (tests, app going to the background).
    func flush(_ q: PlayQueue?, _ h: Playhead?) {
        let qd = q.flatMap { $0.isEmpty ? nil : try? JSONEncoder().encode($0) }
        let hd = h.flatMap { try? JSONEncoder().encode($0) }
        let dir = self.dir, qu = queueURL, hu = headURL
        Self.io.sync {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if let qd { try? qd.write(to: qu, options: .atomic) }
            if let hd { try? hd.write(to: hu, options: .atomic) }
        }
    }
}
