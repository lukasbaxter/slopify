import Foundation
import Network

/// Mobile-data stall cap (web player/linkWatch.js): after a song starves on cellular, the
/// next songs climb one rung lower for 10 minutes. Wi-Fi is left alone.
@MainActor
final class LinkWatch {
    private let monitor = NWPathMonitor()
    private(set) var cellular = false
    private var capUntil: Date = .distantPast
    static let capFor: TimeInterval = 10 * 60

    init() {
        monitor.pathUpdateHandler = { [weak self] p in
            let cell = p.usesInterfaceType(.cellular) && !p.usesInterfaceType(.wifi) && !p.usesInterfaceType(.wiredEthernet)
            Task { @MainActor in self?.cellular = cell }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    func noteStarve() { if cellular { capUntil = Date().addingTimeInterval(Self.capFor) } }

    func profile(_ p: String) -> String { cellular && Date() < capUntil ? StreamPolicy.capped(p) : p }
}
