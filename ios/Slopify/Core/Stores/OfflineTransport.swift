import Foundation

/// A finished song download: where the file landed and its size.
struct OfflineFetched: Sendable, Equatable {
    var file: URL
    var bytes: Int64
}

enum OfflineFetchError: Error, Equatable {
    case http(Int)
    case noFile
}

/// Fetches one file to `base` + the extension the server names (`.flac`, `.m4a`...). The
/// store does not care how; the app uses a background URLSession, tests a stubbed one.
protocol OfflineTransport: AnyObject {
    @MainActor func fetch(_ url: URL, to base: URL) async throws -> OfflineFetched
    @MainActor func cancelAll()
}

enum OfflineFileNaming {
    /// `<base>.<ext>`, the extension from the response's file name (Content-Disposition), else
    /// its MIME type; AAC whole files are `.m4a`. AVPlayer picks the decoder by extension.
    static func finalURL(base: URL, response: URLResponse?) -> URL {
        // Only a named file says its type; otherwise URLResponse makes a name up from the path.
        let named = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") != nil
        var ext = named ? (response?.suggestedFilename as NSString?)?.pathExtension.lowercased() ?? "" : ""
        if ext.isEmpty || ext.count > 5 {
            switch response?.mimeType?.lowercased() ?? "" {
            case "audio/flac", "audio/x-flac": ext = "flac"
            case "audio/mpeg", "audio/mp3": ext = "mp3"
            case "audio/wav", "audio/x-wav", "audio/wave": ext = "wav"
            case "audio/aiff", "audio/x-aiff": ext = "aiff"
            case "audio/aac", "audio/aacp": ext = "aac"
            default: ext = "m4a"
            }
        }
        return base.appendingPathExtension(ext)
    }

    /// Moves a finished temp file into place (replacing an older copy under any extension).
    static func place(_ tmp: URL, base: URL, response: URLResponse?) throws -> OfflineFetched {
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: tmp)
            throw OfflineFetchError.http(http.statusCode)
        }
        let dest = finalURL(base: base, response: response)
        let fm = FileManager.default
        try fm.createDirectory(at: base.deletingLastPathComponent(), withIntermediateDirectories: true)
        removeAll(base: base)
        try fm.moveItem(at: tmp, to: dest)
        let size = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? 0
        return OfflineFetched(file: dest, bytes: size)
    }

    /// Every file named `<base>.*`.
    static func existing(base: URL) -> [URL] {
        let dir = base.deletingLastPathComponent(), stem = base.lastPathComponent
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { ($0 as NSString).deletingPathExtension == stem }.map { dir.appendingPathComponent($0) }
    }

    static func removeAll(base: URL) {
        for u in existing(base: base) { try? FileManager.default.removeItem(at: u) }
    }
}

/// Plain URLSession downloads (tests, and anything that does not need the background).
final class OfflineSessionTransport: OfflineTransport {
    private let session: URLSession
    private var tasks: [Task<OfflineFetched, Error>] = []

    init(session: URLSession) { self.session = session }

    @MainActor func fetch(_ url: URL, to base: URL) async throws -> OfflineFetched {
        let session = session
        let task = Task.detached { () throws -> OfflineFetched in
            let (tmp, resp) = try await session.download(for: URLRequest(url: url))
            return try OfflineFileNaming.place(tmp, base: base, response: resp)
        }
        tasks.append(task)
        defer { tasks.removeAll { $0 == task } }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    @MainActor func cancelAll() { tasks.forEach { $0.cancel() } }
}

/// Background URLSession downloads: they go on with the app suspended, and a download the app
/// was killed during is picked up again by its description (the destination) after relaunch.
final class OfflineBackgroundTransport: NSObject, OfflineTransport, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = OfflineBackgroundTransport()

    private let lock = NSLock()
    /// destination base path -> the fetch waiting for it.
    private var waiting: [String: CheckedContinuation<OfflineFetched, Error>] = [:]
    /// task id -> the placed file (between didFinishDownloading and didComplete).
    private var placed: [Int: Result<OfflineFetched, Error>] = [:]
    private var _session: URLSession?

    private var session: URLSession {
        lock.lock(); defer { lock.unlock() }
        if let s = _session { return s }
        let id = (Bundle.main.bundleIdentifier ?? "slopify") + ".offline"
        let cfg = URLSessionConfiguration.background(withIdentifier: id)
        cfg.sessionSendsLaunchEvents = true
        cfg.isDiscretionary = false
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        _session = s
        return s
    }

    @MainActor func fetch(_ url: URL, to base: URL) async throws -> OfflineFetched {
        let key = base.path
        let session = session
        let running = await session.allTasks.first { $0.taskDescription == key && $0.state == .running }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<OfflineFetched, Error>) in
                lock.lock()
                waiting[key]?.resume(throwing: CancellationError())
                waiting[key] = c
                lock.unlock()
                if running == nil {
                    let t = session.downloadTask(with: url)
                    t.taskDescription = key
                    t.resume()
                }
            }
        } onCancel: { [weak self] in
            self?.cancel(key: key)
        }
    }

    @MainActor func cancelAll() {
        session.getAllTasks { $0.forEach { $0.cancel() } }
    }

    private func cancel(key: String) {
        session.getAllTasks { $0.filter { $0.taskDescription == key }.forEach { $0.cancel() } }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temp file is gone once this returns: move it now.
        guard let key = downloadTask.taskDescription else { return }
        let base = URL(fileURLWithPath: key)
        let r = Result { try OfflineFileNaming.place(location, base: base, response: downloadTask.response) }
        lock.lock(); placed[downloadTask.taskIdentifier] = r; lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let key = task.taskDescription else { return }
        lock.lock()
        let r = placed.removeValue(forKey: task.taskIdentifier)
        let c = waiting.removeValue(forKey: key)
        lock.unlock()
        if let error { c?.resume(throwing: error); return }
        // A download finished for an earlier run with nobody waiting: the file is in place, and
        // the store adopts it when it resumes.
        c?.resume(with: r ?? .failure(OfflineFetchError.noFile))
    }
}
