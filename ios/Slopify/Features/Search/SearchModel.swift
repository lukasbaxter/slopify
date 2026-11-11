import Foundation

/// State of the Search tab (UI.md 6.2.1-6.2.8): the query with its 60 ms debounce, the type chip,
/// focus mode, the result page, the error banner and the "Everywhere" catalogue search with its
/// request polling. The network sits behind `Backend` so tests can drive it.
@MainActor @Observable
final class SearchModel {
    struct Backend {
        var search: @MainActor (String) async throws -> SearchResults
        var playlists: @MainActor () async throws -> [Playlist]
        var everywhere: @MainActor (String) async throws -> EverywhereResults
        /// POST /api/requests; returns the server's `status`.
        var request: @MainActor (String) async throws -> String?
        /// The app is offline: search the downloaded songs instead (`searchOffline`).
        var offline: @MainActor () -> Bool = { false }
        var searchOffline: @MainActor (String) -> [Track] = { _ in [] }

        /// Before the view has the signed-in client: every call is a no-op failure.
        static let idle = Backend(search: { _ in throw CancellationError() }, playlists: { [] },
                                  everywhere: { _ in throw CancellationError() }, request: { _ in throw CancellationError() })

        static func live(_ api: APIClient, offline store: OfflineStore? = nil) -> Backend {
            Backend(
                search: { try await api.search($0, limit: 10) },
                playlists: { try await api.playlists() },
                everywhere: { try await api.searchEverywhere($0) },
                request: { try await api.requestAlbum($0) },
                offline: { Connectivity.shared.offline },
                searchOffline: { store?.search($0) ?? [] })
        }
    }

    enum Everywhere {
        case waiting
        case failed
        case loaded(EverywhereResults)
    }

    private(set) var query = ""
    /// The field was tapped; only Cancel or leaving the tab clears it (blur does not).
    var focused = false
    private(set) var type: SearchType = .all
    private(set) var page: SearchPage?
    private(set) var error: String?
    private(set) var everywhere: Everywhere?
    /// This client's own request states by release id (`queued`, `exists`, `error`).
    private(set) var requesting: [String: String] = [:]
    /// App in the background: polls skip their turn.
    var hidden = false

    var backend: Backend
    var searchDelay: Duration = .milliseconds(60)
    var everywhereDelay: Duration = .milliseconds(300)
    var pollInterval: Duration = .seconds(4)
    var pollLimit: TimeInterval = 30 * 60

    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var everywhereTask: Task<Void, Never>?
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var pollToken = UUID()

    init(backend: Backend) { self.backend = backend }

    var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    var focusMode: Bool { focused || !trimmed.isEmpty }
    /// Chips show once a result object exists, or in Everywhere mode with a query.
    var showsChips: Bool { page != nil || (type == .everywhere && !trimmed.isEmpty) }
    /// The flat phone list; nil before the first result and in Everywhere mode.
    var rows: [SearchItem]? {
        guard let page, type != .everywhere else { return nil }
        return SearchLogic.phoneRows(page, type: type)
    }

    // MARK: input

    func setQuery(_ q: String) {
        guard q != query else { return }
        query = q
        runSearch()
        runEverywhere()
    }

    func setType(_ t: SearchType) {
        guard t != type else { return }
        type = t
        runEverywhere()
    }

    /// Cancel: clear the query and leave focus mode.
    func cancel() {
        focused = false
        setQuery("")
    }

    /// Leaving the tab ends focus mode (the query stays).
    func leftTab() { focused = false; error = nil }

    func clearError() { error = nil }

    // MARK: library search

    private func runSearch() {
        searchTask?.cancel()
        let q = trimmed
        guard !q.isEmpty else { page = nil; return }
        let backend = backend, delay = searchDelay
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            if backend.offline() { self?.showOffline(q); return }
            do {
                let r = try await backend.search(q)
                // The web filters the playlists list client-side; a failure there is not an error.
                let pls = (try? await backend.playlists()) ?? []
                guard !Task.isCancelled, let self, self.trimmed == q else { return }
                self.page = SearchPage(query: q, results: r, playlists: pls)
                self.error = nil
            } catch {
                guard !Task.isCancelled, let self, self.trimmed == q else { return }
                if (error as? APIError) == .offline { self.showOffline(q); return }
                guard Self.reportable(error) else { return }
                self.error = error.localizedDescription
            }
        }
    }

    /// Songs only, from what is downloaded (UI.md 5.8).
    private func showOffline(_ q: String) {
        guard trimmed == q else { return }
        page = SearchPage(query: q, results: SearchResults(tracks: backend.searchOffline(q), albums: [], artists: []), playlists: [])
        error = nil
    }

    /// Aborts and the offline state never show the banner.
    static func reportable(_ e: Error) -> Bool {
        if e is CancellationError { return false }
        if (e as? URLError)?.code == .cancelled { return false }
        if (e as? APIError) == .offline { return false }
        return true
    }

    // MARK: everywhere

    private func runEverywhere() {
        everywhereTask?.cancel()
        pollTask?.cancel(); pollTask = nil
        let q = trimmed
        guard type == .everywhere, !q.isEmpty else { everywhere = nil; return }
        if everywhere == nil { everywhere = .waiting }
        let backend = backend, delay = everywhereDelay
        everywhereTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            do {
                let r = try await backend.everywhere(q)
                guard !Task.isCancelled, let self, self.trimmed == q else { return }
                self.everywhere = .loaded(r)
                self.pollIfPending()
            } catch {
                guard !Task.isCancelled, let self, self.trimmed == q else { return }
                // Any failure (a timeout too) ends the wait with the quiet line; the banner is for real errors.
                self.everywhere = .failed
                if Self.reportable(error) { self.error = error.localizedDescription }
            }
        }
    }

    func state(of r: Release) -> String? {
        SearchRequestState.state(server: r.requestStatus, mine: r.album_id.flatMap { requesting[$0] })
    }

    /// Anything not in the library still on its way (`gPending`).
    var hasPending: Bool {
        guard case .loaded(let r) = everywhere else { return false }
        return r.albums.contains { $0.inLibrary == nil && state(of: $0).map(SearchRequestState.pending.contains) == true }
    }

    func request(_ r: Release) async {
        guard let id = r.album_id else { return }
        requesting[id] = "queued"
        pollIfPending()
        do {
            let st = try await backend.request(id)
            requesting[id] = st ?? "queued"
        } catch {
            requesting[id] = "error"
            if Self.reportable(error) { self.error = error.localizedDescription }
        }
    }

    /// While a requested release is on its way, search again every 4 s so it turns playable when
    /// the library has it. Skips while hidden, stops after 30 min or when nothing is pending.
    private func pollIfPending() {
        guard pollTask == nil, hasPending else { return }
        let q = trimmed, backend = backend, every = pollInterval, limit = pollLimit
        let started = Date(), token = UUID()
        pollToken = token
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: every)
                guard !Task.isCancelled, let self, self.hasPending, self.trimmed == q else { break }
                if Date().timeIntervalSince(started) > limit { break }
                if self.hidden { continue }
                if let r = try? await backend.everywhere(q), !Task.isCancelled, self.trimmed == q, self.type == .everywhere {
                    self.everywhere = .loaded(r)
                }
            }
            if self?.pollToken == token { self?.pollTask = nil }
        }
    }
}
