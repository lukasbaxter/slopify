import SwiftUI

/// What picture to show. Builds the URL from the signed-in `APIClient` (API.md §11): art hashes
/// go to the immutable `/api/art/:hash`, everything else to `/api/image/:id`.
enum CoverSource: Hashable, Sendable {
    /// Album cover; `art` = `Album.cover` hash.
    case album(id: String, art: String?)
    /// A track's album cover; `art` = `Track.cover`.
    case track(id: String, albumId: String?, art: String?)
    /// Playlist cover; `cover` = `Playlist.cover`, used as cache-buster (it changes with the songs).
    case playlist(id: String, cover: String?)
    /// Artist portrait; `image` = `Artist.image` hash.
    case artist(id: String, image: String?)
    /// Artist wide banner.
    case banner(artistId: String)
    /// Library folder picture (`fd_`).
    case folder(id: String)
    case user(id: String)
    /// Any absolute URL (Lidarr release art, now-playing `artUrl`).
    case url(URL?)

    init(_ a: Album) { self = .album(id: a.id, art: a.cover) }
    init(_ t: Track) { self = .track(id: t.id, albumId: t.albumId, art: t.cover) }
    init(_ p: Playlist) { self = .playlist(id: p.id, cover: p.cover) }
    init(_ a: Artist) { self = .artist(id: a.id, image: a.image) }

    /// `size` in pixels (callers pass points x display scale). Nil without an API client.
    @MainActor
    func url(_ api: APIClient?, size: Int) -> URL? {
        if case .url(let u) = self { return u }
        guard let api else { return nil }
        switch self {
        case .album(let id, let art):
            if let art, size <= 640 { return api.artURL(hash: art, size: size) }
            return api.imageURL(id: id, size: size)
        case .track(let id, let albumId, let art):
            if let art, size <= 640 { return api.artURL(hash: art, size: size) }
            return api.imageURL(id: albumId ?? id, size: size)
        case .playlist(let id, let cover):
            return api.imageURL(id: id, size: size, bust: cover)
        case .artist(let id, let image):
            if let image, size <= 640 { return api.artURL(hash: image, size: size) }
            return api.imageURL(id: id, size: size)
        case .banner(let id): return api.imageURL(id: id, size: size, banner: true)
        case .folder(let id): return api.imageURL(id: id, size: size)
        case .user(let id): return api.avatarURL(userId: id)
        case .url(let u): return u
        }
    }
}

private struct APIClientKey: EnvironmentKey {
    static let defaultValue: APIClient? = nil
}

extension EnvironmentValues {
    /// The signed-in API client, for image URLs. The shell sets it: `.environment(\.apiClient, account.api)`.
    var apiClient: APIClient? {
        get { self[APIClientKey.self] }
        set { self[APIClientKey.self] = newValue }
    }
}
