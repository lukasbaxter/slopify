import UIKit

/// Loads and caches artwork. Decoded images live in memory (NSCache); bytes live in a
/// dedicated 512 MB URLCache on disk that honours the server's headers (immutable `/api/art`,
/// 24 h `/api/image`, ETag revalidation for playlists, API.md §11). Requests send
/// `Accept: image/webp,image/jpeg`. Identical requests in flight are shared.
/// The server's own pictures are cached by what they are, not by the address they came from:
/// the app moves between the home and the main address (API.md §4.4) and the covers on screen
/// must stay put when it does.
final class ImageLoader: @unchecked Sendable {
    static let shared = ImageLoader()

    let session: URLSession
    private let memory = NSCache<NSURL, UIImage>()
    private let lock = NSLock()
    private var inflight: [NSURL: Task<UIImage?, Never>] = [:]

    init(diskBytes: Int = 512 << 20, memoryBytes: Int = 64 << 20, protocolClasses: [AnyClass]? = nil) {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("artwork", isDirectory: true)
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 8 << 20, diskCapacity: diskBytes, directory: dir)
        cfg.requestCachePolicy = .useProtocolCachePolicy
        cfg.timeoutIntervalForRequest = 30
        cfg.httpMaximumConnectionsPerHost = 6
        if let protocolClasses { cfg.protocolClasses = protocolClasses }
        session = URLSession(configuration: cfg)
        memory.totalCostLimit = memoryBytes
    }

    /// Already decoded (no I/O): lets a view paint on its first frame without a flash.
    func cached(_ url: URL) -> UIImage? { memory.object(forKey: Self.key(url)) }

    /// Cache key. `/api/art/…`, `/api/image/…` and avatars are the same picture at any of the
    /// server's addresses, so their key is the path from `/api/` on plus the query; any other
    /// URL (Lidarr release art, another site) is its own key.
    static func key(_ url: URL) -> NSURL {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let r = c.percentEncodedPath.range(of: #"/api/(art|image)/|/api/users/[^/]+/avatar$"#, options: .regularExpression) else { return url as NSURL }
        let path = String(c.percentEncodedPath[r.lowerBound...])
        c = URLComponents(); c.scheme = "slopify-server"; c.host = "media"
        c.percentEncodedPath = path
        c.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        return (c.url ?? url) as NSURL
    }

    /// The image at `url`, or nil (404, network, undecodable). Never throws.
    func image(_ url: URL) async -> UIImage? {
        if let hit = cached(url) { return hit }
        let k = Self.key(url)
        let task: Task<UIImage?, Never> = lock.withLock {
            if let t = inflight[k] { return t }
            let t = Task.detached(priority: .userInitiated) { [self] in await self.fetch(url) }
            inflight[k] = t
            return t
        }
        let img = await task.value
        lock.withLock { inflight[k] = nil }
        return img
    }

    /// Raw bytes (for colour sampling without keeping a second decode).
    func data(_ url: URL) async -> Data? {
        var req = URLRequest(url: url)
        req.setValue("image/webp,image/jpeg", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode), !data.isEmpty else { return nil }
        return data
    }

    private func fetch(_ url: URL) async -> UIImage? {
        guard let data = await data(url), let img = UIImage(data: data) else { return nil }
        // Decode now, off the main thread, so the first draw does not stall scrolling.
        let ready = img.preparingForDisplay() ?? img
        let cost = Int(ready.size.width * ready.size.height * ready.scale * ready.scale * 4)
        memory.setObject(ready, forKey: Self.key(url), cost: cost)
        return ready
    }

    /// Drop the decoded copy (e.g. after a playlist cover upload).
    func evict(_ url: URL) { memory.removeObject(forKey: Self.key(url)) }
}
