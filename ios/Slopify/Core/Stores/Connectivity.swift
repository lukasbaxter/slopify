import Foundation

/// App-wide "offline" (web offline/net.js): the phone has no network path, or the server could
/// not be reached and a health check confirms it. While offline the health check runs every
/// 15 s; its first answer, or any live API answer, ends it. Screens read `offline`; the toast
/// centre's offline pill follows it (AppModel).
@MainActor @Observable
final class Connectivity {
    static let shared = Connectivity()

    private(set) var offline = false

    /// `GET /api/healthz` on the address in use, within the timeout. Set by Account.
    @ObservationIgnored var healthCheck: ((TimeInterval) async -> Bool)?
    /// Called on every change.
    @ObservationIgnored var onChange: ((Bool) -> Void)?
    @ObservationIgnored var retryInterval: Duration = .seconds(15)
    @ObservationIgnored var confirmTimeout: TimeInterval = 4

    @ObservationIgnored private var confirming: Task<Void, Never>?
    @ObservationIgnored private var retrying: Task<Void, Never>?

    /// From NWPathMonitor: no path is offline at once; a path back is checked first.
    func pathChanged(satisfied: Bool) {
        if !satisfied { goOffline() } else if offline { Task { await check(timeout: 8) } }
    }

    /// After every request: an answer ends offline; a failed connect is confirmed first, so one
    /// failure on a jittery link does not flip the whole app.
    func note(reachable: Bool) {
        if reachable { goOnline() } else { confirm() }
    }

    /// Signed out: nothing to be offline from.
    func reset() { goOnline() }

    private func confirm() {
        guard confirming == nil, !offline else { return }
        confirming = Task { [weak self] in
            guard let self else { return }
            let ok = await self.healthCheck?(self.confirmTimeout) ?? false
            self.confirming = nil
            if !ok { self.goOffline() }
        }
    }

    @discardableResult
    private func check(timeout: TimeInterval) async -> Bool {
        let ok = await healthCheck?(timeout) ?? false
        if ok { goOnline() }
        return ok
    }

    private func goOffline() {
        guard !offline else { return }
        offline = true
        onChange?(true)
        retrying?.cancel()
        retrying = Task { [weak self] in
            while let self, !Task.isCancelled, self.offline {
                try? await Task.sleep(for: self.retryInterval)
                guard !Task.isCancelled else { return }
                await self.check(timeout: 8)
            }
        }
    }

    private func goOnline() {
        retrying?.cancel(); retrying = nil
        guard offline else { return }
        offline = false
        onChange?(false)
    }
}
