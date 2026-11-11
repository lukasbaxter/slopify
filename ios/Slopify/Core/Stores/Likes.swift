import Foundation

/// Liked tracks, saved albums, followed artists (API.md §9). Shared by every screen's hearts.
@MainActor @Observable
final class Likes {
    private(set) var tracks: [String: Double] = [:]
    private(set) var albums: Set<String> = []
    private(set) var artists: Set<String> = []
    private weak var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    func isLiked(_ id: String) -> Bool { tracks[id] != nil || albums.contains(id) || artists.contains(id) }

    /// True once the liked tracks came back from the server in this run (a heart showing
    /// "not liked" before that may just be unknown).
    private(set) var loaded = false

    func refresh() async {
        guard let api else { return }
        if let m = try? await api.likes() { tracks = m.at; loaded = true }
        if let a = try? await api.savedAlbums() { albums = Set(a.map(\.id)) }
        if let a = try? await api.followedArtists() { artists = Set(a.map(\.id)) }
    }

    /// Signed out: the next account must not see these hearts.
    func reset() { tracks = [:]; albums = []; artists = []; loaded = false }

    /// Track like, album save or artist follow: the server decides by id. Errors are swallowed
    /// (the heart flips back); use `toggleThrowing` to show them.
    func toggle(_ id: String, kind: ItemLookup.Kind = .track) async {
        try? await toggleThrowing(id, kind: kind)
    }

    /// Like `toggle`, but the server's error comes back (after the heart flipped back).
    func toggleThrowing(_ id: String, kind: ItemLookup.Kind = .track) async throws {
        try await set(id, kind: kind, liked: !isLiked(id))
    }

    /// Optimistic: shown at once, rolled back and rethrown when the server says no.
    /// No-op when already in that state.
    func set(_ id: String, kind: ItemLookup.Kind = .track, liked: Bool) async throws {
        guard let api else { throw APIError.offline }
        let was = isLiked(id)
        guard was != liked else { return }
        apply(id, kind: kind, liked: liked)
        do {
            if liked { let r = try await api.like(id); if kind == .track, let at = r.at { tracks[id] = at } }
            else { try await api.unlike(id) }
        } catch {
            apply(id, kind: kind, liked: was)
            throw error
        }
    }

    /// From the socket `like` broadcast (tracks only).
    func remote(_ id: String, liked: Bool, at: Double? = nil) { apply(id, kind: .track, liked: liked, at: at) }

    private func apply(_ id: String, kind: ItemLookup.Kind, liked: Bool, at: Double? = nil) {
        switch kind {
        case .track: tracks[id] = liked ? (at ?? Date().timeIntervalSince1970 * 1000) : nil
        case .album: if liked { albums.insert(id) } else { albums.remove(id) }
        case .artist: if liked { artists.insert(id) } else { artists.remove(id) }
        }
    }
}
