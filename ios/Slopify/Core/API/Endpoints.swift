import Foundation

/// Typed wrappers for the endpoints the app uses (docs/API.md section in each comment).
extension APIClient {
    // §3 auth
    func login(username: String, password: String, device: String) async throws -> LoginResponse {
        struct B: Encodable { var username, password, device: String; var kind = "phone" }
        return try await send("POST", "api/auth/login", body: B(username: username, password: password, device: device))
    }
    /// nil on a normal server (204), a guest session on a demo server.
    func demoSignIn(device: String) async throws -> LoginResponse? {
        struct B: Encodable { var device: String }
        var req = URLRequest(url: url("api/auth/demo")); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(B(device: device))
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
        return try JSONDecoder().decode(LoginResponse.self, from: data)
    }
    func register(invite: String, username: String, password: String) async throws -> LoginResponse {
        struct B: Encodable { var invite, username, password: String }
        return try await send("POST", "api/auth/register", body: B(invite: invite, username: username, password: password))
    }
    func me() async throws -> User { try await get("api/auth/me") }
    func logout() async throws { try await send("POST", "api/auth/logout") }
    func changePassword(current: String?, new: String) async throws {
        struct B: Encodable { var current: String?; var password: String }
        let _: OK = try await send("POST", "api/auth/password", body: B(current: current, password: new))
    }
    func devices() async throws -> [DeviceToken] {
        struct R: Decodable { var devices: [DeviceToken] }
        return try await (get("api/auth/devices") as R).devices
    }
    func revokeDevice(_ id: String) async throws { try await send("DELETE", "api/auth/devices/\(id)") }
    func healthz() async throws -> Bool {
        struct R: Decodable { var ok: Bool }
        return try await (get("api/healthz", timeout: 8) as R).ok
    }
    /// healthz with its own timeout; any failure is false.
    func healthzOK(timeout: TimeInterval) async -> Bool {
        struct R: Decodable { var ok: Bool }
        return (try? await get("api/healthz", as: R.self, timeout: timeout))?.ok == true
    }
    func serverInfo() async throws -> ServerInfo { try await get("api/server") }
    func serverAddresses() async throws -> ServerAddresses { try await get("api/server/addresses") }

    // §6 library, home, search
    func library() async throws -> LibraryInfo { try await get("api/library") }
    func home() async throws -> HomeData { try await get("api/home") }
    /// 8 s: the Search page paints its kept tiles meanwhile.
    func browse() async throws -> [BrowseTile] {
        struct R: Decodable { var tiles: [BrowseTile] }
        return try await (get("api/browse", timeout: 8) as R).tiles
    }
    func search(_ q: String, limit: Int = 20) async throws -> SearchResults { try await get("api/search", ["q": q, "limit": String(limit)]) }
    func searchEverywhere(_ q: String) async throws -> EverywhereResults { try await get("api/gsearch", ["q": q], timeout: 35) }

    // §7 albums, artists, tracks, genres
    func albums(sortAdded: Bool = false, limit: Int = 20000) async throws -> [Album] {
        try await (get("api/albums", ["limit": String(limit), "sort": sortAdded ? "added" : nil]) as Page<Album>).items
    }
    func album(_ id: String) async throws -> AlbumDetail { try await get("api/albums/\(id)") }
    func artists(limit: Int = 20000) async throws -> [Artist] { try await (get("api/artists", ["limit": String(limit)]) as Page<Artist>).items }
    func artist(_ id: String) async throws -> ArtistDetail { try await get("api/artists/\(id)") }
    func artistPopular(_ id: String) async throws -> [String] {
        struct R: Decodable { var ids: [String] }
        return try await (get("api/artists/\(id)/popular", timeout: 15) as R).ids
    }
    func lookup(_ id: String) async throws -> ItemLookup { try await get("api/items/\(id)") }
    func track(_ id: String) async throws -> Track { try await get("api/tracks/\(id)") }
    /// Batches of 100 (URL length); unknown ids are skipped, order kept.
    func tracks(ids: [String]) async throws -> [Track] {
        var out: [Track] = []
        for start in stride(from: 0, to: ids.count, by: 100) {
            let chunk = ids[start..<min(start + 100, ids.count)]
            out += try await (get("api/tracks", ["ids": chunk.joined(separator: ",")]) as Items<Track>).items
        }
        return out
    }
    /// Genre names may hold "/" ("R&B/Soul"): one path segment, escaped (APIClient.segment).
    func genre(_ name: String) async throws -> GenreDetail { try await get("api/genres/\(Self.segment(name))") }
    func genreTracks(_ name: String) async throws -> [Track] { try await (get("api/genres/\(Self.segment(name))/tracks") as Items<Track>).items }
    func genreMix(_ name: String) async throws -> [Track] { try await (get("api/genres/\(Self.segment(name))/mix") as Items<Track>).items }
    func discography(_ artistId: String) async throws -> Discography { try await get("api/discography/\(artistId)") }
    func similar(_ artistId: String) async throws -> [EverywhereResults.ArtistHit] {
        struct R: Decodable { var artists: [EverywhereResults.ArtistHit] }
        return try await (get("api/similar/\(artistId)") as R).artists
    }

    // §8 playlists + layout
    func playlists() async throws -> [Playlist] { try await (get("api/playlists") as Items<Playlist>).items }
    func playlist(_ id: String) async throws -> PlaylistDetail { try await get("api/playlists/\(id)") }
    func createPlaylist(name: String, trackIds: [String] = []) async throws -> Created {
        struct B: Encodable { var name: String; var trackIds: [String] }
        return try await send("POST", "api/playlists", body: B(name: name, trackIds: trackIds))
    }
    func renamePlaylist(_ id: String, name: String) async throws {
        struct B: Encodable { var name: String }
        let _: OK = try await send("PATCH", "api/playlists/\(id)", body: B(name: name))
    }
    func deletePlaylist(_ id: String) async throws { try await send("DELETE", "api/playlists/\(id)") }
    func addToPlaylist(_ id: String, trackIds: [String]) async throws {
        struct B: Encodable { var trackIds: [String] }
        let _: OK = try await send("POST", "api/playlists/\(id)/tracks", body: B(trackIds: trackIds))
    }
    /// Remove positions; sends highest first because positions renumber (§8).
    func removeFromPlaylist(_ id: String, positions: [Int]) async throws {
        for p in positions.sorted(by: >) { try await send("DELETE", "api/playlists/\(id)/tracks/\(p)") }
    }
    func movePlaylistTrack(_ id: String, from: Int, to: Int) async throws {
        struct B: Encodable { var from, to: Int }
        let _: OK = try await send("POST", "api/playlists/\(id)/move", body: B(from: from, to: to))
    }
    func setPlaylistCover(_ id: String, jpeg: Data) async throws {
        let _: OK = try await upload("api/playlists/\(id)/cover", data: jpeg, contentType: "image/jpeg")
    }
    func playlistRecommended(_ id: String, limit: Int = 10, seed: Int = 0) async throws -> [Track] {
        try await (get("api/playlists/\(id)/recommended", ["limit": String(limit), "seed": String(seed)]) as Items<Track>).items
    }
    func libraryLayout() async throws -> LibraryLayout { try await get("api/library/layout") }
    func putLibraryLayout(order: [String], folders: [String: [String]], rev: String) async throws -> LibraryLayout {
        struct B: Encodable { var order: [String]; var folders: [String: [String]] }
        return try await request("PUT", "api/library/layout", query: [:], body: B(order: order, folders: folders), timeout: nil, headers: ["X-Slopify-Rev": rev])
    }
    func createFolder(name: String, rev: String) async throws -> Created {
        struct B: Encodable { var name: String }
        return try await request("POST", "api/library/folders", query: [:], body: B(name: name), timeout: nil, headers: ["X-Slopify-Rev": rev])
    }
    func renameFolder(_ id: String, name: String, rev: String) async throws {
        struct B: Encodable { var name: String }
        let _: OK = try await request("PATCH", "api/library/folders/\(id)", query: [:], body: B(name: name), timeout: nil, headers: ["X-Slopify-Rev": rev])
    }
    /// A folder's own picture; the answer carries its new cover hash.
    @discardableResult
    func setFolderCover(_ id: String, jpeg: Data, rev: String) async throws -> FolderCover {
        var req = URLRequest(url: url("api/library/folders/\(id)/cover"))
        req.httpMethod = "POST"
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.setValue(rev, forHTTPHeaderField: "X-Slopify-Rev")
        req.httpBody = jpeg
        return try await perform(req)
    }
    func deleteFolder(_ id: String, rev: String) async throws {
        let _: OK = try await request("DELETE", "api/library/folders/\(id)", query: [:], body: Optional<Int>.none, timeout: nil, headers: ["X-Slopify-Rev": rev])
    }

    // §9 likes
    func likes(full: Bool = false) async throws -> LikesMap { try await get("api/likes", ["full": full ? "1" : nil]) }
    func like(_ id: String) async throws -> LikeResult {
        struct B: Encodable {}
        return try await send("PUT", "api/likes/\(id)", body: B())
    }
    func unlike(_ id: String) async throws { try await send("DELETE", "api/likes/\(id)") }
    func savedAlbums() async throws -> [Album] { try await (get("api/likes/albums") as Items<Album>).items }
    func followedArtists() async throws -> [Artist] { try await (get("api/likes/artists") as Items<Artist>).items }

    // §10 lyrics
    /// nil when the server knows none (404).
    func lyrics(_ trackId: String) async throws -> Lyrics? {
        do { return try await get("api/lyrics/\(trackId)") }
        catch APIError.http(404, _) { return nil }
    }
    func requestLyricSync(_ trackId: String) async throws -> LyricJob {
        struct B: Encodable {}
        return try await send("POST", "api/lyrics/\(trackId)/sync", body: B())
    }
    /// The jobs for these songs (the server reads the first 100 ids).
    func lyricJobs(ids: [String]) async throws -> [LyricJob] {
        guard !ids.isEmpty else { return [] }
        return try await (get("api/lyrics/sync", ["ids": ids.prefix(100).joined(separator: ",")]) as LyricJobs).jobs
    }
    /// This account's unfinished jobs, running first (picked back up after sign-in).
    func myLyricJobs() async throws -> [LyricJob] { try await (get("api/lyrics/sync", ["mine": "1"]) as LyricJobs).jobs }

    // §14 recommendations
    func mix(_ id: String, limit: Int? = nil, mode: String? = nil) async throws -> Mix {
        let tzo = -TimeZone.current.secondsFromGMT() / 60
        return try await get("api/tracks/\(id)/mix", ["limit": limit.map(String.init), "mode": mode, "tzo": String(tzo)])
    }

    /// Release Radar (§14.2). Slow the first time the server asks upstream: the web waits 120 s.
    func radar() async throws -> [Release] {
        struct R: Decodable { var releases: [Release]? }
        return try await (get("api/radar", timeout: 120) as R).releases ?? []
    }

    // §15 history
    func history(limit: Int = 100, before: Double? = nil) async throws -> HistoryPage {
        try await get("api/history", ["limit": String(limit), "before": before.map { String(Int64($0)) }])
    }
    /// Stats mode (§15.2) for `today | week | 4w | 6m | year`.
    func historyStats(range: String) async throws -> HistoryStats {
        try await get("api/history", ["range": range, "tzo": String(-TimeZone.current.secondsFromGMT() / 60)], timeout: 60)
    }
    func topSongYears() async throws -> TopSongYears { try await get("api/top-songs", ["tzo": String(-TimeZone.current.secondsFromGMT() / 60)]) }
    func topSongs(year: Int) async throws -> [Track] { try await (get("api/top-songs/\(year)", ["tzo": String(-TimeZone.current.secondsFromGMT() / 60)]) as Items<Track>).items }
    /// Only when the socket is down or for offline plays (§15.1).
    func postPlay(trackId: String, at: Double? = nil, client: String) async throws {
        struct B: Encodable { var trackId: String; var at: Double?; var client: String }
        let _: OK = try await send("POST", "api/plays", body: B(trackId: trackId, at: at, client: client))
    }

    // §16 prefs
    func prefs() async throws -> [String: JSONValue] { try await get("api/prefs") }
    func patchPrefs(_ patch: [String: JSONValue]) async throws -> [String: JSONValue] { try await send("PATCH", "api/prefs", body: patch) }

    // §12.4 warming
    func warm(ids: [String], profile: String, norm: String?) async throws {
        struct B: Encodable { var ids: [String]; var profile: String; var norm: String? }
        let _: OK = try await send("POST", "api/stream/warm", body: B(ids: Array(ids.prefix(10)), profile: profile, norm: norm))
    }

    // §18 requests and downloads
    /// Request an upstream album (`album_id` = MusicBrainz id). Returns the server's `status`
    /// (`queued`, `exists`, ...). Lidarr can be slow: 40 s.
    func requestAlbum(_ mbid: String) async throws -> String? {
        struct B: Encodable { var album_id: String }
        struct R: Decodable { var status: String? }
        return try await (request("POST", "api/requests", query: [:], body: B(album_id: mbid), timeout: 40) as R).status
    }
    /// 35 s: the server answers from its kept copy after a few seconds when Lidarr is slow.
    func downloads(scope: DownloadScope) async throws -> DownloadsPage {
        try await get("api/downloads", ["scope": scope.rawValue], timeout: 35)
    }
    func retryDownload(_ id: Int) async throws { try await send("POST", "api/downloads/\(id)/retry") }

    // §17 speakers
    func speakerVolume(_ id: String, level: Int) async throws {
        struct B: Encodable { var level: Int }
        let _: OK = try await send("POST", "api/speakers/\(id)/volume", body: B(level: level))
    }
}
