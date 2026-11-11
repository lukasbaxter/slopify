import Foundation

/// Reconnect delay (API.md §20.2): 1 s, doubling per failure, max 20 s; back to 1 s when the
/// previous connection lived > 5 s.
struct SocketBackoff: Equatable, Sendable {
    static let initial: TimeInterval = 1
    static let maximum: TimeInterval = 20
    static let livedLongEnough: TimeInterval = 5

    private(set) var next: TimeInterval = SocketBackoff.initial

    mutating func reset() { next = Self.initial }

    /// A connection ended. `lived` is nil when it never opened, so a server refusing us right
    /// away keeps doubling instead of looping every second.
    mutating func connectionEnded(lived: TimeInterval?) {
        if let lived, lived > Self.livedLongEnough { reset() }
    }

    /// Delay for the reconnect about to be scheduled; doubles the following one.
    mutating func take() -> TimeInterval {
        let d = next
        next = min(next * 2, Self.maximum)
        return d
    }
}

/// What to do when the socket closes (API.md §20.2).
enum SocketCloseAction: Equatable, Sendable {
    /// Normal path: reconnect with backoff.
    case reconnect
    /// 1009: a frame was too big. Shrink the queue, then reconnect.
    case shrinkAndReconnect
    /// 4000: another socket with our clientId took over. Do not fight it.
    case replaced
    /// 4003: token is dead. Stop and sign out.
    case signedOut

    init(code: Int?) {
        switch code {
        case 4000: self = .replaced
        case 4003: self = .signedOut
        case 1009: self = .shrinkAndReconnect
        default: self = .reconnect
        }
    }
}
