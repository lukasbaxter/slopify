package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.json.JsonObject

/**
 * `GET /api/history?range=&tzo=` (API.md §15.2). Lenient: every field optional, numbers taken
 * as ints or doubles, so an older server never breaks the page.
 */
data class HistoryStats(
    val connected: Boolean,
    val total: Int = 0,
    val spotify: Int = 0,
    val numbers: Numbers = Numbers(),
    val prev: Numbers? = null,
    val topTracks: List<TopTrack> = emptyList(),
    val topArtists: List<TopArtist> = emptyList(),
    val topAlbums: List<TopAlbum> = emptyList(),
    val topGenres: List<Genre> = emptyList(),
    val perDay: List<Day> = emptyList(),
    val byHour: List<Double> = List(24) { 0.0 },
    val byHourSeconds: List<Double>? = null,
) {
    data class Numbers(
        val streams: Int? = null,
        val minutes: Int? = null,
        val daysStreamed: Int? = null,
        val uniqueTracks: Int? = null,
        val uniqueArtists: Int? = null,
        val uniqueAlbums: Int? = null,
    ) {
        companion object {
            fun read(o: JsonObject) = Numbers(
                o["streams"].asInt(), o["minutes"].asInt(), o["daysStreamed"].asInt(),
                o["uniqueTracks"].asInt(), o["uniqueArtists"].asInt(), o["uniqueAlbums"].asInt(),
            )
        }
    }

    data class TopTrack(
        val id: String?, val name: String, val artist: String?, val artistId: String?,
        val albumId: String?, val count: Int, val seconds: Double,
    )
    data class TopArtist(val artistId: String?, val name: String, val count: Int, val seconds: Double)
    data class TopAlbum(val albumId: String?, val name: String, val artist: String?, val count: Int, val seconds: Double)
    data class Genre(val id: String, val name: String)
    data class Day(val day: String, val count: Int, val minutes: Int)

    companion object {
        val reader = LenientReader("HistoryStats") { read(it) }

        private fun JsonObject.req(k: String): String = this[k].asString() ?: error(k)
        private fun JsonObject.reqInt(k: String): Int = this[k].asInt() ?: error(k)
        private fun JsonObject.reqDouble(k: String): Double = this[k].asDouble() ?: error(k)

        fun read(o: JsonObject): HistoryStats = HistoryStats(
            connected = o["connected"].asBool() ?: false,
            total = o["total"].asInt() ?: 0,
            spotify = o["sources"].asObject()?.get("spotify").asDouble()?.toInt() ?: 0,
            numbers = Numbers.read(o),
            prev = o["prev"].asObject()?.let { Numbers.read(it) },
            topTracks = o["topTracks"].lossyList {
                TopTrack(it["id"].asString(), it.req("name"), it["artist"].asString(), it["artistId"].asString(),
                    it["albumId"].asString(), it.reqInt("count"), it.reqDouble("seconds"))
            },
            topArtists = o["topArtists"].lossyList { TopArtist(it["artistId"].asString(), it.req("name"), it.reqInt("count"), it.reqDouble("seconds")) },
            topAlbums = o["topAlbums"].lossyList {
                TopAlbum(it["albumId"].asString(), it.req("name"), it["artist"].asString(), it.reqInt("count"), it.reqDouble("seconds"))
            },
            topGenres = o["topGenres"].lossyList { Genre(it.req("id"), it.req("name")) },
            perDay = o["perDay"].lossyList { Day(it.req("day"), it.reqInt("count"), it.reqInt("minutes")) },
            byHour = o["byHour"].asArray()?.let { a -> a.map { it.asDouble() ?: return@let null } } ?: List(24) { 0.0 },
            byHourSeconds = o["byHourSeconds"].asArray()?.let { a -> a.map { it.asDouble() ?: return@let null } },
        )
    }
}
