import Foundation

/// Album page data (App.jsx openAlbumById): paint the kept copy, then refresh.
@MainActor @Observable
final class DetailAlbumModel {
    let id: String
    private(set) var album: Album?
    private(set) var tracks: [Track] = []
    private(set) var loading = true
    private(set) var loadFailed = false
    private(set) var failedOffline = false
    /// The cover's vibrant colour (raw), once sampled.
    private(set) var sampled: RGB?
    /// Optimistic "Save to Your Library" while the request runs.
    var savedOverride: Bool?

    init(id: String) { self.id = id }

    var hero: RGB { ColorMath.detailHero(sampled: sampled) }

    func load(api: APIClient, scope: String?, cache: DetailCache? = nil) async {
        let cache = cache ?? .shared
        let key = "al.\(id)"
        if let kept: AlbumDetail = cache.load(key, scope: scope) {
            album = kept.album; tracks = kept.tracks; loading = false
        }
        let hadKept = album != nil
        do {
            let d = try await api.album(id)
            album = d.album; tracks = d.tracks; loading = false; loadFailed = false
            cache.save(d, key, scope: scope)
        } catch {
            loading = false
            loadFailed = !hadKept
            failedOffline = (error as? APIError) == .offline
        }
    }

    func sampleColour(api: APIClient) async {
        sampled = await ArtworkColor.shared.vibrant(api.imageURL(id: id, size: 120))
    }

    /// The placeholder note under an empty list (UI.md 6.3.4).
    var emptyNote: String? {
        guard tracks.isEmpty, !loading else { return nil }
        if loadFailed { return failedOffline ? L("Not available offline. Open it once with a connection, or download it.") : L("Couldn’t load this — try again.") }
        return L("This album is empty.")
    }
}
