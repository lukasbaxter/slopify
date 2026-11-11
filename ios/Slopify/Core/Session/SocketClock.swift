import Foundation

/// Server clock estimate and playhead extrapolation (API.md §20.9). All times epoch ms.
struct SocketClock: Equatable, Sendable {
    /// server = local + offset. nil until the first hello-ok / pong.
    private(set) var offset: Double?
    private(set) var bestRtt: Double = .infinity

    static func localNow() -> Double { Date().timeIntervalSince1970 * 1000 }

    /// The shortest round trips win, so one slow sample does not drag the offset.
    mutating func pong(now: Double, t: Double, localNow: Double) {
        let rtt = localNow - t
        guard rtt >= 0, rtt <= bestRtt + 15 else { return }
        bestRtt = min(bestRtt, rtt)
        offset = now - (t + rtt / 2)
    }

    /// A first rough offset from hello-ok, only when none is known yet.
    mutating func helloOk(now: Double, localNow: Double, openedAt: Double) {
        guard offset == nil else { return }
        let rtt = max(0, localNow - openedAt)
        bestRtt = rtt
        offset = now - (localNow - rtt / 2)
    }

    func serverNow(localNow: Double) -> Double { localNow + (offset ?? 0) }

    /// Seconds. `rxAt` = our local receipt time of the report, the fallback when the server
    /// stamp cannot be used. The sender's `at` is never used: other devices' clocks drift.
    func playhead(_ np: NowPlaying, rxAt: Double?, localNow: Double) -> Double {
        if !np.playing || np.held == true { return np.position }
        let since: Double
        if let serverAt = np.serverAt, offset != nil { since = serverNow(localNow: localNow) - serverAt }
        else if let rxAt { since = localNow - rxAt }
        else { since = 0 }
        return np.position + max(0, since) / 1000
    }
}
