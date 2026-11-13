import Foundation

/// Home's data (UI.md 6.1.3, 6.0.15): every list paints from its kept copy first, all sources
/// refresh in parallel, failures are silent (the section keeps its old data or stays hidden).
/// One per signed-in account; switching accounts clears it.
// TODO(lead): a shared library store (albums, artists, playlists) so Home, Library and Search
// do not each fetch the full lists.
@MainActor @Observable
final class HomeStore {
    static let shared = HomeStore()

    struct Snapshot: Codable, Sendable {
        var recent: [Album] = []
        var topArtists: [HomeLogic.RankedArtist] = []
        var recentArtists: [HomeLogic.RankedArtist] = []
        var topYears: [TopSongYears.Year] = []
        /// The full radar list (Home shows the first 16, the Radar page all of them).
        var radar: [Release] = []
        var playlists: [Playlist] = []
        var albums: [Album] = []
        var artists: [Artist] = []
        /// Today's Daily Mix of each seed artist, by artist id (§14.3). Optional: older kept copies lack it.
        var mixSummaries: [String: DailyMixSummary]? = nil
    }

    private(set) var data = Snapshot()
    /// True once the radar has answered (or failed) in this run; the Radar page shows "Checking…" before.
    private(set) var radarLoaded = false
    private(set) var radarError: String?
    private(set) var loadedAt: Date?

    @ObservationIgnored private var key: String?
    @ObservationIgnored private var inflight: Task<Void, Never>?
    /// Where kept copies live; nil keeps nothing (tests).
    @ObservationIgnored var cacheDir: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("slopify-home", isDirectory: true)

    init() {}

    // MARK: Derived

    var shortcuts: [HomeLogic.Shortcut] { HomeLogic.shortcuts(recent: data.recent, playlists: data.playlists, albums: data.albums) }
    var mixSeeds: [HomeLogic.RankedArtist] { HomeLogic.mixSeeds(topArtists: data.topArtists, libraryArtists: data.artists) }
    var radarShelf: [Release] { Array(data.radar.prefix(16)) }
    /// A Daily Mix's subtitle, the same on its tile and its page.
    func mixSub(artistId: String, seedName: String) -> String? {
        HomeLogic.dailyMixSub(seedName: seedName, summary: data.mixSummaries?[artistId])
    }

    func sections(_ filter: HomeLogic.Filter) -> [HomeLogic.Section] {
        HomeLogic.sections(filter: filter, counts: .init(
            mixes: mixSeeds.count, years: data.topYears.count, recent: data.recent.count,
            recentArtists: data.recentArtists.count, radar: data.radar.count, topArtists: data.topArtists.count))
    }

    // MARK: Loading

    /// Switch to this account's kept copy (no-op when already on it).
    func use(key: String?) {
        guard key != self.key else { return }
        inflight?.cancel(); inflight = nil
        self.key = key
        data = Snapshot(); radarLoaded = false; radarError = nil; loadedAt = nil
        if let k = key, let url = fileURL(k), let d = try? Data(contentsOf: url),
           let snap = try? JSONDecoder().decode(Snapshot.self, from: d) { data = snap }
    }

    /// Refresh every source. `maxAge`: skip when the last load is newer than this.
    func load(api: APIClient, maxAge: TimeInterval = 0) async {
        if let at = loadedAt, Date().timeIntervalSince(at) < maxAge { return }
        if let inflight { await inflight.value; return }
        let task = Task { await self.fetchAll(api); await self.loadMixSummaries(api) }
        inflight = task
        await task.value
        inflight = nil
        loadedAt = Date()
        persist()
    }

    private func fetchAll(_ api: APIClient) async {
        await withTaskGroup(of: Void.self) { g in
            g.addTask { await self.loadHome(api) }
            g.addTask { await self.loadYears(api) }
            g.addTask { await self.loadRadar(api) }
            g.addTask { await self.loadPlaylists(api) }
            g.addTask { await self.loadAlbums(api) }
            g.addTask { await self.loadArtists(api) }
        }
    }

    private func loadHome(_ api: APIClient) async {
        guard let h = try? await api.home(), !Task.isCancelled else { return }
        data.recent = Array(h.recentAlbums.prefix(16))
        data.topArtists = HomeLogic.rankTopArtists(h.topTracks)
        // /api/home has no last-played date per track, so this stays empty exactly as on the web.
        data.recentArtists = HomeLogic.recentArtists(h.topTracks) { _ in nil }
    }

    /// After the seeds are known: today's mix of each (the server makes it on a new day). The
    /// answer replaces the kept one whole, so yesterday's names never outlive a fresh answer.
    private func loadMixSummaries(_ api: APIClient) async {
        let ids = mixSeeds.map(\.id)
        guard !ids.isEmpty, let items = try? await api.dailyMixes(ids: ids), !Task.isCancelled else { return }
        data.mixSummaries = Dictionary(items.map { ($0.artistId, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private func loadYears(_ api: APIClient) async {
        guard let y = try? await api.topSongYears(), !Task.isCancelled else { return }
        data.topYears = y.years
    }

    private func loadRadar(_ api: APIClient) async {
        do {
            let r = try await api.radar()
            guard !Task.isCancelled else { return }
            data.radar = r; radarError = nil
        } catch {
            if !Task.isCancelled { radarError = Self.message(error) }
        }
        radarLoaded = true
    }

    /// Radar page: fetch again (the web refetches when the page opens).
    func reloadRadar(api: APIClient) async {
        radarLoaded = false
        await loadRadar(api)
        persist()
    }

    private func loadPlaylists(_ api: APIClient) async {
        guard let p = try? await api.playlists(), !Task.isCancelled else { return }
        data.playlists = p
    }

    private func loadAlbums(_ api: APIClient) async {
        guard let a = try? await api.albums(), !Task.isCancelled else { return }
        data.albums = a
    }

    private func loadArtists(_ api: APIClient) async {
        guard let a = try? await api.artists(), !Task.isCancelled else { return }
        data.artists = a
    }

    /// Local patch after a request: the release shows its new state at once.
    func setRequestStatus(_ albumId: String, _ status: String) {
        for i in data.radar.indices where data.radar[i].album_id == albumId { data.radar[i].requestStatus = status }
    }

    // MARK: Keeping

    private func fileURL(_ key: String) -> URL? {
        let safe = key.map { $0.isLetter || $0.isNumber ? $0 : "_" }
        return cacheDir?.appendingPathComponent(String(safe) + ".json")
    }

    private func persist() {
        guard let k = key, let url = fileURL(k), let d = try? JSONEncoder().encode(data) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: url, options: .atomic)
    }

    nonisolated static func message(_ e: Error) -> String {
        switch e {
        case APIError.http(_, let m): m
        default: e.localizedDescription
        }
    }

    /// The kept-copy key of the signed-in account: server + user (never a hard-coded name).
    static func key(for account: Account) -> String? {
        guard let main = account.saved?.main, let user = account.user?.id else { return nil }
        return main + "|" + user
    }
}
