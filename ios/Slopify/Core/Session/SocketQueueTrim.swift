import Foundation

/// Fits a published queue frame under the budget (API.md §20.3: keep it ≤ ~2.5 MB; the server
/// drops > 3 MB and closes on > 4 MiB). Cuts from the end to 80% until it fits, like the web.
enum SocketQueueTrim {
    static let maxBytes = Int(2.5 * 1024 * 1024)

    /// Returns the items kept and the encoded `{ type: "queue", queue }` frame.
    static func frame(_ queue: [QueueItem], maxBytes: Int = maxBytes) -> (queue: [QueueItem], frame: Data) {
        var q = queue
        var data = encode(q)
        while q.count > 1, data.count > maxBytes {
            // ceil(2 * 0.8) == 2 would never shrink (the web loops forever there): always cut one.
            let keep = min(Int((Double(q.count) * 0.8).rounded(.up)), q.count - 1)
            q = Array(q.prefix(keep))
            data = encode(q)
        }
        return (q, data)
    }

    static func encode(_ q: [QueueItem]) -> Data {
        (try? SocketOutgoing.queue(q).data()) ?? Data()
    }
}
