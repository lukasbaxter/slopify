import Foundation

/// What the Browse state paints (UI.md 6.2.5): the genre tiles from `GET /api/browse` and the
/// covers of the four "Start browsing" tiles. Painted from the local copy first, then refreshed
/// (UI.md 6.0.15). Keyed per server and user so two accounts never share tiles.
@MainActor @Observable
final class SearchBrowseData {
    struct Saved: Codable {
        var tiles: [BrowseTile]?
        /// Daily Mix 1's seed: the top artist from Home, else the first library artist.
        var topArtist: String?
        var firstArtist: String?
        /// Album of the most played track (`browse.chartsTop`).
        var chartsTop: String?
        var recentAlbum: String?
        /// First two library albums (A-Z), the fallbacks of New Releases and Charts.
        var firstAlbums: [String] = []
    }

    private(set) var saved = Saved()
    private var key: String?

    var tiles: [BrowseTile]? { saved.tiles }
    var madeForYouCover: String? { saved.topArtist ?? saved.firstArtist }
    /// Home never writes `home.added`, so this is the first library album (UI.md 6.2.5 note).
    var newReleasesCover: String? { saved.firstAlbums.first }
    var chartsCover: String? { saved.chartsTop ?? saved.recentAlbum ?? (saved.firstAlbums.count > 1 ? saved.firstAlbums[1] : nil) }

    static func storageKey(account: Account) -> String? {
        guard let user = account.user, let main = account.saved?.main else { return nil }
        return "slopify.browse.\(main).\(user.id)"
    }

    func use(key: String?) {
        guard key != self.key else { return }
        self.key = key
        saved = key.flatMap(Self.load) ?? Saved()
    }

    nonisolated static func load(_ key: String) -> Saved? {
        guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Saved.self, from: d)
    }

    private func persist() {
        guard let key, let d = try? JSONEncoder().encode(saved) else { return }
        UserDefaults.standard.set(d, forKey: key)
    }

    func refresh(api: APIClient) async {
        async let tiles = try? api.browse()
        async let home = try? api.home()
        async let albums = try? api.albums(limit: 2)
        async let artists = try? api.artists(limit: 1)
        let (t, h, al, ar) = await (tiles, home, albums, artists)
        if let t { saved.tiles = t }
        if let h {
            saved.topArtist = SearchLogic.topArtistIds(h.topTracks).first
            saved.chartsTop = h.topTracks.first?.albumId
            saved.recentAlbum = h.recentAlbums.first?.id
        }
        if let al { saved.firstAlbums = al.map(\.id) }
        if let ar { saved.firstArtist = ar.first?.id }
        persist()
    }

    /// The colour a genre's tile had (DECISIONS: genre pages take their tile colour).
    nonisolated static func tileColor(genre: String, tiles: [BrowseTile]?) -> RGB? {
        guard let i = tiles?.firstIndex(where: { $0.name == genre }) else { return nil }
        return SearchLogic.tileColor(i)
    }
}
