package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.json.JsonObject

/**
 * `GET /api/downloads?scope=` (API.md §18.2): album acquisition requests. Lenient: unknown
 * states and missing fields are kept out of the way rather than failing the page.
 */
data class DownloadsPage(
    val items: List<Item>,
    val stuckAfterMs: Double? = null,
    val watcher: Watcher? = null,
) {
    data class Search(val at: Double? = null, val results: Int? = null, val outcome: String? = null)

    data class Item(
        val id: Int,
        val title: String,
        val artist: String? = null,
        val type: String? = null,
        val year: String? = null,
        val image: String? = null,
        val state: String,
        val total: Int = 0,
        val done: Int = 0,
        val requested: Double? = null,
        val started: Double? = null,
        val progressAt: Double? = null,
        val finished: Double? = null,
        val reason: String? = null,
        val via: String? = null,
        val detail: String? = null,
        val libraryAlbumId: String? = null,
        val note: String? = null,
        val search: Search? = null,
    )

    data class Watcher(
        val lastCheck: Double? = null,
        val next: Double? = null,
        val checking: Boolean? = null,
        val perCheck: Int? = null,
        val wanted: Int? = null,
    )

    companion object {
        val reader = LenientReader("DownloadsPage") { read(it) }

        fun read(o: JsonObject) = DownloadsPage(
            items = o["items"].lossyList { readItem(it) },
            stuckAfterMs = o["stuckAfterMs"].asDouble(),
            watcher = o["watcher"].asObject()?.let {
                Watcher(it["lastCheck"].asDouble(), it["next"].asDouble(), it["checking"].asBool(), it["perCheck"].asInt(), it["wanted"].asInt())
            },
        )

        /** Only `id` is required; the rest falls back. */
        private fun readItem(o: JsonObject): Item? {
            val id = o["id"].asInt() ?: return null
            return Item(
                id = id, title = o["title"].asString() ?: "", artist = o["artist"].asString(), type = o["type"].asString(),
                year = o["year"].asStringOrNumber(), image = o["image"].asString(), state = o["state"].asString() ?: "",
                total = o["total"].asInt() ?: 0, done = o["done"].asInt() ?: 0, requested = o["requested"].asDouble(),
                started = o["started"].asDouble(), progressAt = o["progressAt"].asDouble(), finished = o["finished"].asDouble(),
                reason = o["reason"].asString(), via = o["via"].asString(), detail = o["detail"].asString(),
                libraryAlbumId = o["libraryAlbumId"].asString(), note = o["note"].asString(),
                search = o["search"].asObject()?.let { Search(it["at"].asDouble(), it["results"].asInt(), it["outcome"].asString()) },
            )
        }
    }
}

/** `scope=` of `GET /api/downloads`: this account's requests, or everything Lidarr is moving. */
enum class DownloadScope(val wire: String) { Mine("mine"), All("all") }
