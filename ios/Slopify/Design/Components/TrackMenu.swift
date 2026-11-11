import Foundation

/// The one track menu (UI.md 5.4.5, TrackRow.jsx:210-236), built from state + actions so it is
/// testable. Every list uses it; `TrackMenuBuilder` wires the actions to the app.
/// "Download ▸" file export is left out (DECISIONS 5).
enum TrackMenu {
    enum Style {
        /// A track row (TrackRow.jsx:210-236).
        case row
        /// The now playing ⋯ sheet (FullScreen.jsx:221-240): no taste-profile row, a separator
        /// before Sync Lyrics, artist falls back to the first artist id.
        case nowPlaying
    }

    struct State {
        var track: Track
        var liked: Bool
        var excluded: Bool
        var downloaded = false
        var syncing = false
        var offline = false
        /// The user's playlists for "Add to playlist".
        var playlists: [Playlist] = []
        var style: Style = .row
        /// Context rows after Share (now playing: the sleep timer).
        var trailing: [MenuItem] = []
    }

    struct Actions {
        var addToQueue: (Track) -> Void = { _ in }
        var newPlaylist: (Track) -> Void = { _ in }
        var addTo: (Playlist, Track) -> Void = { _, _ in }
        /// "Remove from this playlist": only a user playlist's own page passes it.
        var remove: ((Track) -> Void)? = nil
        var like: (Track, Bool) -> Void = { _, _ in }
        var exclude: (Track, Bool) -> Void = { _, _ in }
        var radio: (Track) -> Void = { _ in }
        var openArtist: (String) -> Void = { _ in }
        var openAlbum: (String) -> Void = { _ in }
        var syncLyrics: (Track) -> Void = { _ in }
        var share: (Track) -> Void = { _ in }
    }

    static func header(_ t: Track) -> MenuHeader {
        MenuHeader(art: .cover(.init(t)), title: t.title, subtitle: TrackRow.artistLine(t))
    }

    static func items(_ s: State, _ a: Actions) -> [MenuItem] {
        let t = s.track
        let sub = playlistSub(s.playlists, new: { a.newPlaylist(t) }, add: { p in a.addTo(p, t) })
        var artists = t.artistCredits.compactMap { c in c.id.map { (name: c.name, id: $0) } }.filter { !$0.id.isEmpty }
        // FullScreen.jsx:233: the session's artistId when no credit carries one.
        if artists.isEmpty, s.style == .nowPlaying, let id = t.artistIds.first, !id.isEmpty { artists = [(t.artist, id)] }

        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: s.downloaded) { a.addToQueue(t) },
            MenuItem(L("Add to playlist"), icon: .plus, sub: sub),
        ]
        if let remove = a.remove {
            items.append(MenuItem(L("Remove from this playlist"), icon: .trash) { remove(t) })
        }
        items.append(MenuItem(s.liked ? L("Remove from Liked Songs") : L("Add to Liked Songs"), icon: s.liked ? .heartFilled : .heart) { a.like(t, !s.liked) })
        if s.style == .row {
            items.append(MenuItem(s.excluded ? L("Include in your taste profile") : L("Exclude from your taste profile"), icon: .ban) { a.exclude(t, !s.excluded) })
        }
        items.append(.separator)
        items.append(MenuItem(L("Go to song radio"), icon: .radio) { a.radio(t) })
        if artists.count == 1 {
            let id = artists[0].id
            items.append(MenuItem(L("Go to artist"), icon: .artist, offline: true) { a.openArtist(id) })
        } else if artists.count > 1 {
            items.append(MenuItem(L("Go to artist"), icon: .artist, offline: true,
                                  sub: artists.map { x in MenuItem(x.name, offline: true) { a.openArtist(x.id) } }))
        }
        if !t.albumId.isEmpty {
            items.append(MenuItem(L("Go to album"), icon: .album, offline: true) { a.openAlbum(t.albumId) })
        }
        if s.style == .nowPlaying { items.append(.separator) }
        items.append(MenuItem(s.syncing ? L("Syncing Lyrics…") : L("Sync Lyrics"), icon: .lyrics, disabled: s.syncing) { a.syncLyrics(t) })
        // FullScreen.jsx G16.share: now playing has its own share glyph.
        items.append(MenuItem(L("Share"), icon: s.style == .nowPlaying ? .share16 : .share) { a.share(t) })
        items += s.trailing
        return s.offline ? MenuItem.offlineSubset(items) : MenuItem.tidy(items)
    }

    /// "Add to playlist ▸": New playlist, a separator when there are playlists, one row each.
    static func playlistSub(_ playlists: [Playlist], new: @escaping () -> Void, add: @escaping (Playlist) -> Void) -> [MenuItem] {
        var sub: [MenuItem] = [MenuItem(L("New playlist"), icon: .plus, action: new)]
        if !playlists.isEmpty { sub.append(.separator) }
        sub += playlists.map { p in MenuItem(p.name) { add(p) } }
        return sub
    }

    /// The New playlist prompt's start text (App.jsx:1060): the album, else "My Playlist".
    static func newPlaylistName(_ seed: Track?) -> String {
        guard let album = seed?.album, !album.isEmpty else { return L("My Playlist") }
        return album
    }

    // MARK: Share (TrackRow.jsx:38-57)

    enum ShareKind: String { case track, album, artist }

    /// `{main}/?{kind}={id}` on the server's main address.
    static func shareURL(main: String, kind: ShareKind, id: String) -> URL? {
        var base = main
        while base.hasSuffix("/") { base.removeLast() }
        guard var c = URLComponents(string: base + "/") else { return nil }
        c.queryItems = [URLQueryItem(name: kind.rawValue, value: id)]
        return c.url
    }

    static func shareTitle(_ title: String, by: String?) -> String {
        guard let by, !by.isEmpty else { return title }
        return "\(title) — \(by)"
    }

    /// `by` of a track share: the artist names (TrackRow.jsx:233, no album-artist fallback).
    static func shareBy(_ t: Track) -> String { t.artists.filter { !$0.isEmpty }.joined(separator: ", ") }

    // MARK: Taste profile (prefs.dislikes = { trackId: ms })

    static func isExcluded(_ id: String, prefs: [String: JSONValue]) -> Bool { prefs["dislikes"]?.object?[id] != nil }

    static func dislikes(_ prefs: [String: JSONValue], setting id: String, excluded: Bool, now: Double) -> [String: JSONValue] {
        var cur = prefs["dislikes"]?.object ?? [:]
        if excluded { cur[id] = .number(now) } else { cur[id] = nil }
        return cur
    }
}
