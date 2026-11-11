import Foundation

/// Where the Downloads page gets its data. The app uses the server; tests use a fake.
@MainActor
protocol AccountDownloadsSource: AnyObject {
    func downloads(scope: DownloadScope) async throws -> DownloadsPage
    func retry(id: Int) async throws
    /// The tracks of a library album (the Play button).
    func albumTracks(_ albumId: String) async throws -> [Track]
}

@MainActor
final class AccountServerDownloadsSource: AccountDownloadsSource {
    let api: APIClient
    init(api: APIClient) { self.api = api }

    func downloads(scope: DownloadScope) async throws -> DownloadsPage {
        try await api.downloads(scope: scope)
    }
    func retry(id: Int) async throws {
        try await api.retryDownload(id)
    }
    func albumTracks(_ albumId: String) async throws -> [Track] {
        try await api.album(albumId).tracks
    }
}
