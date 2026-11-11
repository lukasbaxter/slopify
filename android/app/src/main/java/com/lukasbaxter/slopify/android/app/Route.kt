package com.lukasbaxter.slopify.android.app

import kotlinx.serialization.Serializable

/** Every pushable screen. Features push these with `nav.push(route)`; `RouteDestination` maps them to screens. */
@Serializable
sealed interface Route {
    @Serializable data class Album(val id: String, val highlightTrack: String? = null) : Route
    @Serializable data class Artist(val id: String) : Route
    @Serializable data class Playlist(val id: String) : Route
    @Serializable data object LikedSongs : Route

    /**
     * An artist's Daily Mix (Home "Made For You"): `number` is its 1-based place on the shelf
     * (title "Daily Mix {n}", tile colour), `seedName` the artist ("{name} and more").
     */
    @Serializable data class DailyMix(val artistId: String, val number: Int, val seedName: String) : Route

    /** `colorIndex`: the tile's place on Home's Your Top Songs shelf. */
    @Serializable data class TopSongs(val year: Int, val colorIndex: Int) : Route
    @Serializable data class Genre(val name: String) : Route
    @Serializable data object Charts : Route
    @Serializable data class Folder(val id: String) : Route
    @Serializable data object ReleaseRadar : Route
    @Serializable data class SeeAll(val kind: SeeAllKind) : Route
    @Serializable data object Profile : Route
    @Serializable data object History : Route
    @Serializable data object Downloads : Route
    @Serializable data object Settings : Route
    @Serializable data object Scrobbling : Route
}

@Serializable
enum class SeeAllKind { Albums, Artists, TopArtists }
