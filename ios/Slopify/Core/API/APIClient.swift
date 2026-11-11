import Foundation

/// One signed-in server. All REST calls go through `get/send`; media URLs come from
/// the URL builders so the token rides in the query (API.md §3.1, §11, §12).
/// `baseURL` can move between the main and home address at runtime (§4.4).
@MainActor
final class APIClient {
    var baseURL: URL
    var token: String?
    /// Called on any 401 (except login): the app signs out.
    var onUnauthorized: (() -> Void)?
    /// Called on 403 "password change required".
    var onPasswordChangeRequired: (() -> Void)?
    /// true after any server answer, false when the server could not be reached (Connectivity).
    var onReachability: ((Bool) -> Void)?

    let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL, token: String? = nil, session: URLSession? = nil) {
        self.baseURL = baseURL
        self.token = token
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 30
            cfg.waitsForConnectivity = false
            self.session = URLSession(configuration: cfg)
        }
    }

    // MARK: - Requests

    /// `path` is "/"-separated; a segment escaped with `segment(_:)` stays one segment even when
    /// it holds "/" (`appendingPathComponent` would split "R&B/Soul" into two).
    func url(_ path: String, _ query: [String: String?] = [:]) -> URL {
        var u = baseURL
        for seg in path.split(separator: "/") { u = u.appending(component: seg.removingPercentEncoding ?? String(seg), directoryHint: .notDirectory) }
        var c = URLComponents(url: u, resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }.sorted { $0.name < $1.name }
        if !items.isEmpty { c.queryItems = items }
        return c.url!
    }

    func get<T: Decodable>(_ path: String, _ query: [String: String?] = [:], as: T.Type = T.self, timeout: TimeInterval? = nil) async throws -> T {
        try await request("GET", path, query: query, body: Optional<Int>.none, timeout: timeout)
    }

    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, as: T.Type = T.self) async throws -> T {
        try await request(method, path, query: [:], body: body, timeout: nil)
    }

    @discardableResult
    func send(_ method: String, _ path: String) async throws -> OK {
        try await request(method, path, query: [:], body: Optional<Int>.none, timeout: nil)
    }

    /// Raw bytes upload (covers, avatar).
    func upload<T: Decodable>(_ path: String, data: Data, contentType: String, as: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        return try await perform(req)
    }

    func request<T: Decodable, B: Encodable>(_ method: String, _ path: String, query: [String: String?], body: B?, timeout: TimeInterval?, headers: [String: String] = [:]) async throws -> T {
        var req = URLRequest(url: url(path, query))
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(body)
        }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        return try await perform(req)
    }

    func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        var req = req
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) }
        catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .timedOut].contains(e.code) {
            // Like the web, a timeout alone says nothing about the link (a slow server).
            if e.code != .timedOut { onReachability?(false) }
            throw APIError.offline
        }
        onReachability?(true)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? decoder.decode(ErrorBody.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: status)
            if status == 401 && !(req.url?.path.hasSuffix("/auth/login") ?? false) { onUnauthorized?(); throw APIError.unauthorized }
            if status == 403 && msg == "password change required" { onPasswordChangeRequired?(); throw APIError.passwordChangeRequired }
            throw APIError.http(status, msg)
        }
        if T.self == Empty.self || data.isEmpty, let e = Empty() as? T { return e }
        do { return try decoder.decode(T.self, from: data) }
        catch { throw APIError.decoding("\(req.url?.path ?? ""): \(error)") }
    }

    private struct ErrorBody: Decodable { var error: String }
    struct Empty: Codable {}

    /// One path segment from free text (a genre name): every reserved character escaped.
    nonisolated static func segment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }

    // MARK: - Media URLs (token in query: GET only)

    /// Album cover by art hash (immutable). Snaps to 64/160/320/640.
    func artURL(hash: String, size: Int) -> URL {
        let snapped = [64, 160, 320, 640].first { $0 >= size } ?? 640
        return url("api/art/\(hash)/\(snapped).webp")
    }

    /// Picture by id: album, track, artist, playlist (pl_), folder (fd_). `bust` = playlist cover hash.
    func imageURL(id: String, size: Int, banner: Bool = false, bust: String? = nil) -> URL {
        url("api/image/\(id)", ["size": String(size), "kind": banner ? "banner" : nil, "w": banner ? String(size) : nil, "c": bust.map { String($0.prefix(10)) }])
    }

    /// HLS master for a track. `max`: aac-96|aac-160|aac-320|alac. `norm`: track|album|nil.
    func hlsURL(trackId: String, max: String, norm: String?) -> URL {
        url("api/stream/\(trackId)/hls/master.m3u8", ["max": max, "norm": max == "alac" ? nil : norm, "token": token])
    }

    func wholeFileURL(trackId: String, profile: String, norm: String?) -> URL {
        url("api/stream/\(trackId)/whole/\(profile)", ["norm": norm, "token": token])
    }

    func downloadURL(trackId: String, fmt: String = "original") -> URL {
        url("api/download/\(trackId)", ["fmt": fmt, "token": token])
    }

    func avatarURL(userId: String) -> URL { url("api/users/\(userId)/avatar") }

    var webSocketURL: URL {
        var c = URLComponents(url: baseURL.appendingPathComponent("api/ws"), resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        return c.url!
    }
}
