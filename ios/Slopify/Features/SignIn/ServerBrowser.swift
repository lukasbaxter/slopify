import Foundation
import Network
import Observation

/// Slopify servers on this network (API.md 4.6): Bonjour `_slopify._tcp`, TXT `id` + `name`.
@MainActor @Observable
final class ServerBrowser {
    struct Found: Identifiable, Equatable {
        let id: String
        let name: String
        let endpoint: NWEndpoint
    }

    private(set) var found: [Found] = []
    @ObservationIgnored private var browser: NWBrowser?

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_slopify._tcp", domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let list = results.compactMap(Self.found).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
            Task { @MainActor in self?.found = list }
        }
        b.start(queue: .main)
        browser = b
    }

    func stop() {
        browser?.cancel(); browser = nil
        found = []
    }

    nonisolated static func found(_ r: NWBrowser.Result) -> Found? {
        guard case .service(let service, _, _, _) = r.endpoint else { return nil }
        var id = service, name = service
        if case .bonjour(let txt) = r.metadata {
            if let v = txt["id"], !v.isEmpty { id = v }
            if let v = txt["name"], !v.isEmpty { name = v }
        }
        return Found(id: id, name: name, endpoint: r.endpoint)
    }

    /// The plain http address behind a found service (the server advertises its HTTP port).
    /// IPv4 only: a link-local IPv6 needs a zone that URLs carry badly.
    static func resolve(_ endpoint: NWEndpoint, timeout: TimeInterval = 4) async -> URL? {
        let params = NWParameters.tcp
        (params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        let conn = NWConnection(to: endpoint, using: params)
        let once = Once()
        return await withCheckedContinuation { (cont: CheckedContinuation<URL?, Never>) in
            let finish: @Sendable (URL?) -> Void = { url in
                guard once.claim() else { return }
                conn.cancel()
                cont.resume(returning: url)
            }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = conn.currentPath?.remoteEndpoint {
                        finish(address(host: host, port: port.rawValue))
                    } else { finish(nil) }
                case .failed, .cancelled: finish(nil)
                default: break
                }
            }
            conn.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }

    nonisolated static func address(host: NWEndpoint.Host, port: UInt16) -> URL? {
        let h: String
        switch host {
        case .ipv4(let a): h = "\(a)"
        case .name(let n, _): h = n
        default: return nil
        }
        let bare = h.split(separator: "%").first.map(String.init) ?? h
        return Address.normalise("http://\(bare):\(port)")
    }
}

/// First caller wins (continuation resumed exactly once).
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.withLock { if done { return false }; done = true; return true } }
}
