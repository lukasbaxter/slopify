import Foundation

/// One WebSocket connection. IO and JSON parsing run on URLSession's queue and a background
/// task; the session client consumes `events` in order on the main actor.
final class SocketConnection: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Event: Sendable {
        case open
        case message(SocketMessage)
        /// `code` nil = network failure without a close frame.
        case closed(code: Int?)
    }

    let events: AsyncStream<Event>
    private let continuation: AsyncStream<Event>.Continuation
    private let lock = NSLock()
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private var finished = false

    init(url: URL) {
        (events, continuation) = AsyncStream.makeStream(of: Event.self)
        super.init()
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .userInitiated
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: q)
        task = session.webSocketTask(with: url)
        // Before hello the server closes frames > 2 KB; after it, a queue can be up to 4 MiB.
        task.maximumMessageSize = 8 * 1024 * 1024
    }

    func start() { task.resume() }

    /// Fire and forget; order is preserved by the task.
    func send(_ data: Data) {
        guard let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    /// Our own close: no `closed` event follows.
    func close() {
        lock.lock(); let was = finished; finished = true; lock.unlock()
        continuation.finish()
        if !was { task.cancel(with: .normalClosure, reason: nil) }
        session.invalidateAndCancel()
    }

    private func finish(code: Int?) {
        lock.lock(); let was = finished; finished = true; lock.unlock()
        guard !was else { return }
        continuation.yield(.closed(code: code))
        continuation.finish()
        session.invalidateAndCancel()
    }

    private func receiveLoop() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(msg):
                let parsed: SocketMessage?
                switch msg {
                case let .string(s): parsed = SocketMessage.parse(s)
                case let .data(d): parsed = SocketMessage.parse(d)
                @unknown default: parsed = nil
                }
                if let parsed { self.continuation.yield(.message(parsed)) }
                self.receiveLoop()
            case .failure:
                // The close frame (if any) arrives via the delegate; didComplete always follows.
                break
            }
        }
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        continuation.yield(.open)
        receiveLoop()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(code: closeCode.rawValue)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let code = (task as? URLSessionWebSocketTask)?.closeCode.rawValue ?? 0
        finish(code: code == 0 ? nil : code)
    }
}

/// What `SessionClient` needs from a connection. Tests swap in a fake; no real network.
protocol SocketTransport: AnyObject, Sendable {
    var events: AsyncStream<SocketConnection.Event> { get }
    func start()
    func send(_ data: Data)
    func close()
}

extension SocketConnection: SocketTransport {}
