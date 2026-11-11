import Foundation

/// Lyric sync jobs (api/lyricsync.js), one store for the whole app: the track menus' "Syncing
/// Lyrics…" row, the lyrics tab and the lyric-sync pill all read it. Start a job, follow every
/// unfinished one every 2 s, toast the outcome, bump `revision[trackId]` so an open lyrics view
/// reloads, and pick up this account's unfinished jobs after sign-in (`?mine=1`).
@MainActor @Observable
final class LyricJobStore {
    static let shared = LyricJobStore()

    private(set) var jobs: [String: LyricJob] = [:]
    /// Insertion order (the web's Map order), for the pill.
    private(set) var order: [String] = []
    /// Bumped when a job for that track finishes.
    private(set) var revision: [String: Int] = [:]

    /// Poll interval; tests shorten it.
    @ObservationIgnored var interval: TimeInterval = 2
    @ObservationIgnored private var api: APIClient?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private weak var account: Account?
    @ObservationIgnored private var signedIn = false

    func job(_ trackId: String?) -> LyricJob? { trackId.flatMap { jobs[$0] } }
    func isSyncing(_ trackId: String?) -> Bool { job(trackId) != nil }

    static func isActive(_ j: LyricJob) -> Bool { j.state == "queued" || j.state == "running" }

    /// `jobLabel`: what a job is doing, in words.
    static func label(_ j: LyricJob) -> String {
        if j.state == "queued" {
            if let n = j.ahead, n > 0 { return L("Waiting · {n} ahead", ["n": n]) }
            return L("Starting")
        }
        return j.step ?? L("Starting")
    }

    // MARK: Sign-in

    /// Follow the account: on sign-in resume its unfinished jobs, on sign-out forget them.
    func attach(_ account: Account) {
        if self.account !== account { self.account = account; signedIn = false }
        watch()
    }

    private func watch() {
        guard let account else { return }
        let now = withObservationTracking { account.state == .signedIn } onChange: { [weak self] in
            Task { @MainActor in self?.watch() }
        }
        guard now != signedIn else { return }
        signedIn = now
        if now { Task { await resume(api: account.api) } } else { reset() }
    }

    /// `resumeLyricJobs`: jobs this account started before a relaunch.
    func resume(api: APIClient) async {
        self.api = api
        guard let list = try? await api.myLyricJobs() else { return }
        absorb(list)
        follow()
    }

    func reset() {
        poll?.cancel(); poll = nil; api = nil
        jobs = [:]; order = []
        updatePill()
    }

    // MARK: Start

    func sync(_ t: Track, api: APIClient) async { await sync(trackId: t.id, title: t.title, api: api) }

    func sync(trackId: String, title: String, api: APIClient) async {
        self.api = api
        do {
            var j = try await api.requestLyricSync(trackId)
            let already = j.already == true
            if j.title?.isEmpty ?? true { j.title = title }
            put(j)
            if already { ToastCenter.shared.show(L("Already syncing \"{name}\"", ["name": title])) }
            follow()
        } catch {
            let m = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            ToastCenter.shared.show(L("Couldn't sync lyrics: {error}", ["error": m]))
        }
    }

    // MARK: Follow

    /// Merge a poll result (`absorb`): active jobs update, finished ones toast and leave.
    func absorb(_ list: [LyricJob]) {
        for var j in list {
            let before = jobs[j.trackId]
            let title = (j.title?.isEmpty == false ? j.title : nil) ?? before?.title ?? L("This song")
            j.title = title
            if Self.isActive(j) { put(j); continue }
            guard before != nil else { continue }
            jobs[j.trackId] = nil
            order.removeAll { $0 == j.trackId }
            let result = j.result ?? (j.state == "failed" ? L("Couldn't sync") : L("Done"))
            ToastCenter.shared.show("\(title): \(result)", seconds: 5)
            revision[j.trackId, default: 0] += 1
        }
        updatePill()
    }

    private func put(_ j: LyricJob) {
        if jobs[j.trackId] == nil { order.append(j.trackId) }
        jobs[j.trackId] = j
        updatePill()
    }

    /// LyricSyncStatus.jsx: the running job, else the first; "· n more".
    private func updatePill() {
        let list = order.compactMap { jobs[$0] }
        guard let j = list.first(where: { $0.state == "running" }) ?? list.first else {
            if ToastCenter.shared.lyricSync != nil { ToastCenter.shared.lyricSync = nil }
            return
        }
        ToastCenter.shared.lyricSync = .init(title: j.title ?? L("This song"), stage: Self.label(j), more: list.count - 1)
    }

    private func follow() {
        guard poll == nil, !order.isEmpty else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64((self?.interval ?? 2) * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                let pending = self.order
                if pending.isEmpty { self.poll = nil; return }
                guard let api = self.api else { continue }
                if let list = try? await api.lyricJobs(ids: pending), !Task.isCancelled { self.absorb(list) }
            }
        }
    }

}
