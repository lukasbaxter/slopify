import Foundation

/// Your Library's data for every screen that needs it (library list, playlist pages, every
/// "Add to playlist" submenu): own playlists, saved albums, followed artists and the server
/// layout, painted from a local copy first and then refreshed (UI.md 5.2.6, 6.0.15).
///
/// Layout changes are optimistic (Sidebar.jsx `commit`): shown at once, sent with a fresh
/// `X-Slopify-Rev`, rolled back with a toast if the server says no.
/// AppModel owns the app's store (one per signed-in account: `attach` switches it).
@MainActor @Observable
final class LibraryStore {
    /// The app's store; AppModel sets it to the one it owns.
    static var shared = LibraryStore()

    private(set) var playlists: [Playlist] = []
    private(set) var albums: [Album] = []
    private(set) var artists: [Artist] = []
    private(set) var layout: LibraryLayout?
    /// True until the first fetch of playlists + albums + artists finished.
    private(set) var loading = true
    /// Liked Songs rows (newest liked first) and when each was liked, from `GET /api/likes?full=1`.
    private(set) var likedRows: [String: Track] = [:]
    private(set) var likedAt: [String: Double] = [:]
    private(set) var likedLoaded = false
    /// Playlist pages last seen, for an instant repaint.
    private(set) var details: [String: PlaylistDetail] = [:]
    /// Bumped when a playlist's songs change elsewhere (Add to playlist): its open page reloads.
    private(set) var revision: [String: Int] = [:]
    /// "Edit details" from Your Library: the playlist page opens its dialog once shown.
    var pendingEditDetails: String?

    @ObservationIgnored private(set) weak var api: APIClient?
    @ObservationIgnored private var userId: String?
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var inflight = 0
    @ObservationIgnored private var mine = Set<String>()
    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private var refreshing = false

    init() {
        observer = NotificationCenter.default.addObserver(forName: .libraryChanged, object: nil, queue: .main) { [weak self] note in
            // The object is the socket's prefs patch: our own layout rev coming back is skipped.
            let rev = (note.object as? [String: JSONValue])?["_libraryLayout"]?.string
            MainActor.assumeIsolated { self?.remoteChange(rev: rev) }
        }
    }

    /// Point the store at the signed-in account. A different user starts from their own cache.
    func attach(api: APIClient, userId: String?) {
        self.api = api
        guard userId != self.userId else { return }
        self.userId = userId
        seq += 1; mine = []
        playlists = []; albums = []; artists = []; layout = nil; loading = true
        likedRows = [:]; likedAt = [:]; likedLoaded = false; details = [:]
        if let userId { restore(userId) }
    }

    // MARK: - Loading

    func refresh() async {
        guard let api, !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        async let p = try? api.playlists()
        async let a = try? api.savedAlbums()
        async let r = try? api.followedArtists()
        let (pl, al, ar) = await (p, a, r)
        if let pl { playlists = pl }
        if let al { albums = al }
        if let ar { artists = ar }
        loading = false
        loadLayout()
        persist()
    }

    func refreshPlaylists() async {
        guard let api, let pl = try? await api.playlists() else { return }
        playlists = pl
        persist()
    }

    func refreshAlbums() async {
        guard let api, let al = try? await api.savedAlbums() else { return }
        albums = al
        persist()
    }

    func refreshArtists() async {
        guard let api, let ar = try? await api.followedArtists() else { return }
        artists = ar
        persist()
    }

    /// Re-read the layout unless one of our own changes is on its way (it would undo it).
    func loadLayout() {
        guard let api else { return }
        let at = seq
        Task {
            guard let l = try? await api.libraryLayout(), inflight == 0, at == seq else { return }
            setLayout(l)
        }
    }

    private func remoteChange(rev: String?) {
        if let rev, mine.contains(rev) { return }
        Task { await refresh() }
    }

    private func setLayout(_ l: LibraryLayout?) { layout = l; persist() }

    /// Show `next` now; `call(rev)` makes the server change and may answer with its layout.
    func commit(_ next: LibraryLayout, _ call: @escaping (_ rev: String) async throws -> LibraryLayout?) {
        guard let api else { return }
        let prev = layout
        seq += 1
        let my = seq, rev = Self.newRev()
        mine.insert(rev)
        setLayout(next)
        inflight += 1
        Task {
            defer { inflight -= 1 }
            do {
                let res = try await call(rev)
                guard my == seq else { return }
                if let res { setLayout(res) }
                else if let l = try? await api.libraryLayout(), my == seq { setLayout(l) }
            } catch {
                if my == seq { setLayout(prev) }
                ToastCenter.shared.show(L("Could not save Your Library: {error}", ["error": error.localizedDescription]))
            }
        }
    }

    /// `r<time base36><random>`, like the web's `newRev`.
    nonisolated static func newRev() -> String {
        let t = String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
        let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return "r" + t + String((0..<6).map { _ in chars.randomElement()! })
    }

    // MARK: - Arrangement

    func arrangement(pinned: [String]) -> LibraryArrangement {
        LibraryArrangement(playlists: playlists, albums: albums, artists: artists, layout: layout, pinned: pinned)
    }

    func saveArrangement(_ d: LibraryArrangement.Draft) {
        guard let api else { return }
        let order = d.order, folders = d.folders
        commit(d.layout) { rev in try await api.putLibraryLayout(order: order, folders: folders, rev: rev) }
    }

    func createFolder(_ name: String, arrangement a: LibraryArrangement) {
        guard let api else { return }
        let tmp = "fd_new" + String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36)
        let d = LibraryArrangement.creatingFolder(a.draft(layout: layout), tempId: tmp, name: name)
        commit(d.layout) { rev in _ = try await api.createFolder(name: name, rev: rev); return nil }
    }

    func renameFolder(_ id: String, name: String, arrangement a: LibraryArrangement) {
        guard let api else { return }
        let d = LibraryArrangement.renamingFolder(a.draft(layout: layout), id: id, name: name)
        commit(d.layout) { rev in try await api.renameFolder(id, name: name, rev: rev); return nil }
    }

    func deleteFolder(_ id: String, arrangement a: LibraryArrangement) {
        guard let api else { return }
        let d = LibraryArrangement.deletingFolder(a.draft(layout: layout), id: id)
        commit(d.layout) { rev in try await api.deleteFolder(id, rev: rev); return nil }
    }

    func setFolderCover(_ id: String, jpeg: Data) {
        guard let api, let current = layout else { return }
        commit(current) { rev in try await api.setFolderCover(id, jpeg: jpeg, rev: rev); return nil }
    }

    // MARK: - Playlists

    /// Tell the account's other devices (App.jsx `sendPrefs({_libraryChanged})`). AppModel sets it.
    @ObservationIgnored var onLibraryChanged: (() -> Void)?

    @discardableResult
    func createPlaylist(name: String, with track: Track? = nil) async -> Created? {
        guard let api else { return nil }
        do {
            let c = try await api.createPlaylist(name: name, trackIds: track.map { [$0.id] } ?? [])
            await refreshPlaylists()
            onLibraryChanged?()
            ToastCenter.shared.show(track != nil ? L("Added to {name}", ["name": name]) : L("Created {name}", ["name": name]))
            return c
        } catch {
            ToastCenter.shared.show(L("Could not create playlist: {error}", ["error": error.localizedDescription]))
            return nil
        }
    }

    /// The one way every "Add to playlist" goes (API.md 8.2): asks about each song already there
    /// (or twice in `tracks`), then one request with what is kept, one toast. `onError` replaces
    /// the error toast (a page banner). True when it finished without an error.
    @discardableResult
    func add(_ tracks: [Track], to p: Playlist, onError: ((Error) -> Void)? = nil) async -> Bool {
        guard let api, !tracks.isEmpty else { return false }
        let ids = tracks.map(\.id)
        // A server without the route: go on as if none were there.
        let existing = Set((try? await api.playlistContains(p.id, trackIds: ids)) ?? [])
        let dup = PlaylistAdd.duplicates(ids, existing: existing)
        let ask = askDuplicate
        let (kept, skipped) = await PlaylistAdd.resolve(ids, duplicates: dup) { i, left in
            await ask(tracks[i], p, left > 1)
        }
        do {
            if !kept.isEmpty {
                try await api.addToPlaylist(p.id, trackIds: kept)
            }
            ToastCenter.shared.show(PlaylistAdd.toast(added: kept.count, skipped: skipped, name: p.name))
            if !kept.isEmpty {
                revision[p.id, default: 0] += 1
                await refreshPlaylists()
            }
            return true
        } catch {
            if let onError { onError(error) } else {
                ToastCenter.shared.show(L("Could not add: {error}", ["error": error.localizedDescription]))
            }
            return false
        }
    }

    /// The "Already added" question (song, playlist, show "Do this for all"). Tests answer it.
    @ObservationIgnored var askDuplicate: (Track, Playlist, Bool) async -> PlaylistAdd.Answer = { t, p, showAll in
        await DuplicateDialog.shared.ask(song: t.title, playlist: p.name, showAll: showAll)
    }

    /// True when deleted.
    func deletePlaylist(_ p: Playlist) async -> Bool {
        guard let api else { return false }
        do {
            try await api.deletePlaylist(p.id)
            details[p.id] = nil
            await refreshPlaylists()
            onLibraryChanged?()
            ToastCenter.shared.show(L("Deleted {name}", ["name": p.name]))
            return true
        } catch {
            ToastCenter.shared.show(L("Could not delete: {error}", ["error": error.localizedDescription]))
            return false
        }
    }

    /// Edit details: rename and/or a new cover. True when saved.
    func edit(_ p: Playlist, name: String, jpeg: Data?) async -> Bool {
        guard let api else { return false }
        do {
            if name != p.name { try await api.renamePlaylist(p.id, name: name) }
            if let jpeg { try await api.setPlaylistCover(p.id, jpeg: jpeg) }
            await refreshPlaylists()
            ToastCenter.shared.show(L("Playlist updated"))
            return true
        } catch {
            ToastCenter.shared.show(L("Could not update playlist: {error}", ["error": error.localizedDescription]))
            return false
        }
    }

    func remember(_ d: PlaylistDetail) { details[d.playlist.id] = d }

    // MARK: - Liked Songs

    func loadLiked() async {
        guard let api, let m = try? await api.likes(full: true) else { return }
        var rows: [String: Track] = [:]
        for t in m.items ?? [] { rows[t.id] = t }
        likedRows = rows; likedAt = m.at; likedLoaded = true
        persist()
    }

    /// Liked ids the store has no row for yet (liked on another device): fetch them.
    func fillLiked(_ ids: [String]) async {
        guard let api, !ids.isEmpty, let more = try? await api.tracks(ids: ids) else { return }
        for t in more { likedRows[t.id] = t }
        persist()
    }

    // MARK: - Local copy

    private struct Snapshot: Codable {
        var playlists: [Playlist]
        var albums: [Album]
        var artists: [Artist]
        var layout: LibraryLayout?
        var liked: [Track]
        var likedAt: [String: Double]
    }

    private func file(_ userId: String) -> URL {
        let safe = userId.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("library-\(safe).json")
    }

    private func restore(_ userId: String) {
        guard let d = try? Data(contentsOf: file(userId)), let s = try? JSONDecoder().decode(Snapshot.self, from: d) else { return }
        playlists = s.playlists; albums = s.albums; artists = s.artists; layout = s.layout
        for t in s.liked { likedRows[t.id] = t }
        likedAt = s.likedAt
        likedLoaded = !s.likedAt.isEmpty
    }

    @ObservationIgnored private var saveTask: Task<Void, Never>?

    private func persist() {
        guard let userId else { return }
        saveTask?.cancel()
        let s = Snapshot(playlists: playlists, albums: albums, artists: artists, layout: layout, liked: Array(likedRows.values), likedAt: likedAt)
        let url = file(userId)
        saveTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let data = try? JSONEncoder().encode(s) else { return }
            try? data.write(to: url, options: .atomic)
        }
    }
}
