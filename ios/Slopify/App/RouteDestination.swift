import SwiftUI

struct RouteDestination: View {
    let route: Route
    var body: some View {
        switch route {
        case let .album(id, hl): AlbumView(id: id, highlightTrack: hl)
        case let .artist(id): ArtistView(id: id)
        case let .playlist(id): PlaylistView(id: id)
        case .likedSongs: LikedSongsView()
        case let .dailyMix(a, n, s): DailyMixView(artistId: a, number: n, seedName: s)
        case let .topSongs(y, c): TopSongsView(year: y, colorIndex: c)
        case let .genre(n): GenreView(name: n)
        case .charts: SearchBrowsePage(kind: .charts)
        case let .folder(id): FolderView(id: id)
        case .releaseRadar: ReleaseRadarView()
        case let .seeAll(k): SeeAllView(kind: k)
        case .profile: ProfileView()
        case .history: HistoryView()
        case .downloads: DownloadsView()
        case .settings: SettingsView()
        case .scrobbling: ScrobblingView()
        }
    }
}
