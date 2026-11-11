import Foundation
import UIKit

/// Songs kept on this device for listening with no connection (web api/offline.js +
/// offline/store.js). Whole files under Application Support, per server:
///
///     Offline/<server>/files/<trackId>.<ext>        shared by every account on that server
///     Offline/<server>/users/<userId>/index.json    one account's collections + offline plays
///
/// A song in two collections is stored once; removing a collection deletes only what no
/// collection of any account still holds. Signing out keeps everything (web: the library is
/// per account and stays); the next sign-in of that account sees it again.
/// Downloads run one collection after another, 2 songs at a time, 3 tries each.
@MainActor @Observable
final class OfflineStore {
    /// The app's store, for helpers that have no environment (TrackMenuBuilder, LibraryContext).
    static var shared: OfflineStore?

    private(set) var index = OfflineIndex()
    /// The collection downloading now.
    private(set) var active: OfflineProgress?
    /// Downloaded track ids (kept apart so rows read a Set, not the index).
    private(set) var downloaded: Set<String> = []

    /// A collection finished (the completion toast).
    @ObservationIgnored var onFinished: ((OfflineProgress) -> Void)?
    /// Retry back-off base in seconds: 1.5, 3, 4.5 (store.js).
    @ObservationIgnored var retryDelay: Double = 1.5
    @ObservationIgnored var parallel = 2
    /// Bytes free on the device, nil when unknown.
    @ObservationIgnored var freeSpace: () -> Int64? = {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }
    @ObservationIgnored var isOffline: () -> Bool = { Connectivity.shared.offline }
    /// A download could not reach the server (Connectivity confirms and flips the app offline).
    @ObservationIgnored var noteUnreachable: () -> Void = { Connectivity.shared.note(reachable: false) }

    @ObservationIgnored let root: URL
    @ObservationIgnored private let makeTransport: () -> OfflineTransport
    @ObservationIgnored private var _transport: OfflineTransport?
    private var transport: OfflineTransport {
        if let t = _transport { return t }
        let t = makeTransport(); _transport = t; return t
    }
    @ObservationIgnored private(set) var api: APIClient?
    @ObservationIgnored private var prefs: () -> [String: JSONValue] = { [:] }
    @ObservationIgnored private var tablet = false
    @ObservationIgnored private(set) var scope: (server: String, user: String)?

    @ObservationIgnored private var jobs: [String] = []
    @ObservationIgnored private var pump: Task<Void, Never>?
    @ObservationIgnored private var pumpToken: UUID?
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private let writes = DispatchQueue(label: "slopify.offline.index")

    nonisolated static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Offline", isDirectory: true)
    }

    init(root: URL = OfflineStore.defaultRoot, transport: @escaping () -> OfflineTransport = { OfflineBackgroundTransport.shared }) {
        self.root = root
        self.makeTransport = transport
    }

    // MARK: Account

    /// Signed in: this account's library on this server. The same account again is a no-op.
    func attach(api: APIClient, server: String, userId: String, prefs: @escaping () -> [String: JSONValue], tablet: Bool? = nil) {
        self.api = api; self.prefs = prefs; self.tablet = tablet ?? (UIDevice.current.userInterfaceIdiom == .pad)
        let key = (Self.safe(server), Self.safe(userId))
        if let s = scope, s.server == key.0, s.user == key.1 { return }
        stopJobs()
        scope = key
        index = load()
        refreshDownloaded()
    }

    /// Signed out: downloads stop, nothing of this account stays in memory; files stay.
    func detach() {
        stopJobs()
        writes.sync {}
        scope = nil; api = nil
        index = OfflineIndex()
        refreshDownloaded()
    }

    // MARK: Queries

    /// Something is queued or downloading.
    var working: Bool { pump != nil || !jobs.isEmpty }

    func has(_ trackId: String) -> Bool { downloaded.contains(trackId) }
    func summary(_ id: String) -> OfflineSummary? { index.summary(id) }
    func busy(_ id: String) -> OfflineProgress? { active?.id == id ? active : nil }
    func search(_ q: String) -> [Track] { index.search(q) }
    func downloadedTracks(of id: String) -> [Track] { index.downloadedTracks(of: id) }
    /// Collections holding at least one downloaded song (Your Library offline).
    var heldCollections: Set<String> { Set(index.collections.filter { (index.summary($0.id)?.have ?? 0) > 0 }.map(\.id)) }

    func glyph(_ id: String, pageTotal: Int) -> DownloadGlyph.State {
        OfflineRules.glyph(held: summary(id), busy: busy(id), pageTotal: pageTotal)
    }

    /// The downloaded file for the player (online or not, a downloaded song never streams).
    func localFile(_ trackId: String) -> URL? {
        guard let name = index.tracks[trackId]?.file, let dir = filesDir else { return nil }
        let u = dir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    func playable(_ tracks: [Track], at index: Int) -> (tracks: [Track], index: Int)? {
        OfflineRules.playable(tracks, at: index, offline: isOffline(), has: has)
    }

    func estimateBytes(_ tracks: [Track]) -> Double {
        OfflineRules.estimateBytes(tracks, lossless: OfflineRules.savesLossless(prefs: prefs(), tablet: tablet))
    }

    // MARK: Save / remove

    enum Saved: Equatable { case later, now }

    enum Failure: LocalizedError, Equatable {
        case noRoom(need: Double, free: Double)
        case signedOut
        var errorDescription: String? {
            switch self {
            case let .noRoom(need, free):
                L("Not enough room: needs about {need} GB, {free} GB free", ["need": String(format: "%.1f", need / 1e9), "free": String(format: "%.1f", free / 1e9)])
            case .signedOut: L("Not signed in")
            }
        }
    }

    /// `saveOffline`: remember the collection, then download what is missing (offline: only
    /// remembered; `resume` downloads it once the server answers).
    @discardableResult
    func save(id: String, name: String, kind: OfflineKind, tracks: [Track]) throws -> Saved {
        guard scope != nil else { throw Failure.signedOut }
        let need = estimateBytes(tracks)
        if let free = freeSpace(), Double(free) < need { throw Failure.noRoom(need: need, free: Double(free)) }
        let p = prefs()
        var seen = Set<String>()
        let songs = tracks.filter { !$0.id.isEmpty && seen.insert($0.id).inserted }.map { t -> OfflineTrack in
            let plan = OfflineRules.plan(t, kind: kind, prefs: p, tablet: tablet)
            return OfflineTrack(track: t, q: plan.q, norm: plan.norm)
        }
        let col = OfflineCollection(id: id, name: name, kind: kind, trackIds: [], added: (Date().timeIntervalSince1970 * 1000).rounded())
        let r = index.upsert(col, songs: songs)
        deleteUnheld(r.replaced)
        persist()
        refreshDownloaded()
        if isOffline() { return .later }
        enqueue(id)
        return .now
    }

    /// `removeOffline`: the collection goes, and the songs nothing else holds.
    func remove(_ id: String) {
        jobs.removeAll { $0 == id }
        let files = index.remove(id)
        persist()
        deleteUnheld(files)
        refreshDownloaded()
    }

    /// Once the server answers (app start, back online): finish downloads cut short. Files that
    /// a background download placed while the app was gone are taken over first.
    func resume() {
        guard scope != nil, !isOffline() else { return }
        adoptPlaced()
        for c in index.collections where c.trackIds.contains(where: { index.tracks[$0]?.file == nil }) { enqueue(c.id) }
    }

    /// Back online: resume and send the plays made offline.
    func wentOnline() {
        resume()
        Task { await flushPlays() }
    }

    // MARK: Offline plays

    func recordPlay(_ trackId: String, at: Double) {
        guard scope != nil else { return }
        index.plays.append(OfflinePlay(id: trackId, at: at))
        persist()
    }

    /// `flushOfflinePlays`: oldest first, stop at the first failure, drop what was sent.
    func flushPlays() async {
        guard !flushing, let api, !index.plays.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        var upTo: Double?
        for p in index.plays.sorted(by: { $0.at < $1.at }) {
            do { try await api.postPlay(trackId: p.id, at: p.at, client: "offline") } catch { break }
            upTo = p.at
        }
        guard let upTo else { return }
        index.plays.removeAll { $0.at <= upTo }
        persist()
    }

    // MARK: Downloading

    private func enqueue(_ id: String) {
        guard active?.id != id, !jobs.contains(id) else { return }
        jobs.append(id)
        if pump == nil {
            let token = UUID()
            pumpToken = token
            pump = Task { [weak self] in
                while let self, !Task.isCancelled, self.pumpToken == token, !self.jobs.isEmpty {
                    let next = self.jobs.removeFirst()
                    await self.run(next)
                }
                if self?.pumpToken == token { self?.pump = nil }
            }
        }
    }

    /// One collection's run, shared by its parallel workers.
    @MainActor private final class Run {
        var todo: [String]
        var p: OfflineProgress
        var paused = false
        init(todo: [String], p: OfflineProgress) { self.todo = todo; self.p = p }
    }

    private func run(_ id: String) async {
        guard let col = index.collection(id) else { return }
        let todo = col.trackIds.filter { index.tracks[$0]?.file == nil }
        let total = col.trackIds.count
        let r = Run(todo: todo, p: OfflineProgress(id: id, name: col.name, done: total - todo.count, total: total, failed: 0))
        active = r.p
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<max(1, parallel) {
                group.addTask { @MainActor [weak self] in
                    while let self, !Task.isCancelled, !r.paused, !r.todo.isEmpty {
                        let tid = r.todo.removeFirst()
                        guard self.index.collection(id) != nil else { return }   // removed meanwhile
                        if self.index.tracks[tid]?.file != nil { r.p.done += 1; self.publish(r.p); continue }
                        switch await self.download(tid) {
                        case .ok: r.p.done += 1
                        case .failed: r.p.failed += 1
                        case .paused: r.paused = true; return
                        }
                        self.publish(r.p)
                    }
                }
            }
        }
        if active?.id == id { active = nil }
        // Cut off by the network or sign-out: no toast, resume picks it up.
        guard !r.paused, !Task.isCancelled, index.collection(id) != nil else { return }
        onFinished?(r.p)
    }

    private func publish(_ p: OfflineProgress) { if active?.id == p.id { active = p } }

    private enum Outcome { case ok, failed, paused }

    private func download(_ tid: String) async -> Outcome {
        guard let t = index.tracks[tid], let api, let dir = filesDir else { return .failed }
        let url = t.q == "original" ? api.downloadURL(trackId: tid) : api.wholeFileURL(trackId: tid, profile: t.q, norm: t.norm)
        let base = dir.appendingPathComponent(Self.safe(tid))
        for attempt in 0..<3 {
            if Task.isCancelled { return .paused }
            do {
                let got = try await transport.fetch(url, to: base)
                guard index.tracks[tid] != nil else {
                    // Its collection went while it downloaded.
                    deleteUnheld([got.file.lastPathComponent]); return .failed
                }
                index.tracks[tid]?.file = got.file.lastPathComponent
                index.tracks[tid]?.bytes = got.bytes
                persist()
                refreshDownloaded()
                return .ok
            } catch {
                if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return .paused }
                if Self.unreachable(error) { noteUnreachable(); return .paused }
                if attempt < 2 { try? await Task.sleep(for: .seconds(retryDelay * Double(attempt + 1))) }
            }
        }
        return .failed
    }

    private static func unreachable(_ e: Error) -> Bool {
        guard let u = e as? URLError else { return false }
        return [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost].contains(u.code)
    }

    private func stopJobs() {
        jobs = []
        pump?.cancel(); pump = nil; pumpToken = nil
        _transport?.cancelAll()
        active = nil
    }

    /// Songs whose file a background download put in place while the app was not running.
    private func adoptPlaced() {
        guard let dir = filesDir else { return }
        var changed = false
        for (id, t) in index.tracks where t.file == nil {
            guard let f = OfflineFileNaming.existing(base: dir.appendingPathComponent(Self.safe(id))).first else { continue }
            index.tracks[id]?.file = f.lastPathComponent
            index.tracks[id]?.bytes = (try? FileManager.default.attributesOfItem(atPath: f.path)[.size] as? NSNumber)?.int64Value ?? 0
            changed = true
        }
        if changed { persist(); refreshDownloaded() }
    }

    // MARK: Files

    private var serverDir: URL? { scope.map { root.appendingPathComponent($0.server, isDirectory: true) } }
    private var filesDir: URL? { serverDir?.appendingPathComponent("files", isDirectory: true) }
    private var indexURL: URL? {
        guard let scope, let serverDir else { return nil }
        return serverDir.appendingPathComponent("users", isDirectory: true).appendingPathComponent(scope.user, isDirectory: true).appendingPathComponent("index.json")
    }

    private func load() -> OfflineIndex {
        guard let u = indexURL, let data = try? Data(contentsOf: u) else { return OfflineIndex() }
        return (try? JSONDecoder().decode(OfflineIndex.self, from: data)) ?? OfflineIndex()
    }

    /// Written in order on a serial queue, atomically.
    private func persist() {
        guard let u = indexURL, let data = try? JSONEncoder().encode(index) else { return }
        writes.async {
            try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: u, options: .atomic)
            var v = URLResourceValues(); v.isExcludedFromBackup = true
            var dir = u.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            try? dir.setResourceValues(v)
        }
    }

    /// Waits for pending index writes (tests, sign-out).
    func flushWrites() { writes.sync {} }

    /// Deletes these files unless a collection of this or any other account still holds them.
    private func deleteUnheld(_ names: [String]) {
        guard !names.isEmpty, let dir = filesDir else { return }
        let held = index.files.union(heldByOthers())
        for n in Set(names) where !held.contains(n) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(n)) }
    }

    private func heldByOthers() -> Set<String> {
        writes.sync {}
        guard let scope, let users = serverDir?.appendingPathComponent("users", isDirectory: true) else { return [] }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: users.path)) ?? []
        var held = Set<String>()
        for n in names where n != scope.user {
            let u = users.appendingPathComponent(n).appendingPathComponent("index.json")
            guard let d = try? Data(contentsOf: u), let other = try? JSONDecoder().decode(OfflineIndex.self, from: d) else { continue }
            held.formUnion(other.files)
        }
        return held
    }

    private func refreshDownloaded() {
        let now = index.downloadedIds
        if now != downloaded { downloaded = now }
    }

    /// A folder name from free text (server address, ids).
    static func safe(_ s: String) -> String {
        let ok = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        let out = String(s.unicodeScalars.map { ok.contains($0) ? Character($0) : "_" })
        return out.isEmpty ? "_" : out
    }

    /// The server part of the folder: the main address without scheme (home and main of one
    /// server share it).
    static func serverKey(_ main: String) -> String {
        guard let u = URL(string: main), let host = u.host else { return main }
        let port = u.port.map { ":\($0)" } ?? ""
        let path = u.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return host.lowercased() + port + (path.isEmpty ? "" : "/" + path)
    }
}
