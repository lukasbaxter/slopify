import Foundation

/// Every pushable screen. Features push these with `NavigationLink(value:)` or
/// `nav.push(_:)`; `RouteDestination` maps them to views.
enum Route: Hashable {
    case album(id: String, highlightTrack: String? = nil)
    case artist(id: String)
    case playlist(id: String)
    case likedSongs
    /// An artist's Daily Mix (Home "Made For You"): `number` is its 1-based place on the shelf
    /// (title "Daily Mix {n}", tile colour), `seedName` the artist ("{name} and more").
    case dailyMix(artistId: String, number: Int, seedName: String)
    /// Go to radio (§14.4): the listener's radio of an artist, song, album or playlist. `name`: the
    /// seed's name when the caller knows it, so the title shows before the radio loads.
    case radio(seedId: String, name: String?)
    /// `colorIndex`: the tile's place on Home's Your Top Songs shelf.
    case topSongs(year: Int, colorIndex: Int)
    case genre(name: String)
    case charts
    case folder(id: String)
    case releaseRadar
    case seeAll(SeeAll)
    case profile
    case history
    case downloads
    case settings
    case scrobbling

    enum SeeAll: String, Hashable { case albums, artists, topArtists }
}
