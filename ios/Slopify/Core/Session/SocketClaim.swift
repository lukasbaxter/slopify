import Foundation

/// Claim bookkeeping for re-assertion (API.md §20.7). Times epoch ms.
struct SocketClaim: Equatable, Sendable {
    static let maxAgo: Double = 7 * 24 * 3600 * 1000

    private(set) var claimed = false
    private(set) var claimedAt: Double = 0

    /// Local play press.
    mutating func claim(at now: Double) { claimed = true; claimedAt = now }
    /// `command.yield`: someone else took over; never reassert this one.
    mutating func yielded() { claimed = false }
    /// `ago` for a `{ claim, reassert }` after hello-ok, or nil when nothing is held.
    func reassertAgo(now: Double) -> Double? {
        guard claimed else { return nil }
        return min(max(0, now - claimedAt), Self.maxAgo)
    }
}
