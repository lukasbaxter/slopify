package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.lookup
import com.lukasbaxter.slopify.android.core.api.playlist
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.ItemKind
import com.lukasbaxter.slopify.android.design.L
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** "PLAYING FROM <KIND>" / "<name>" (usePlayingFrom, Player.jsx:23-59). Always two lines. */
data class NowPlayingFrom(val kind: String, val name: String) {
    companion object {
        val fallback: NowPlayingFrom get() = NowPlayingFrom(L("PLAYING FROM"), L("Your Library"))

        /** What a context id names without a lookup; null when it needs one. */
        fun immediate(ctx: String?): NowPlayingFrom? {
            if (ctx.isNullOrEmpty()) return fallback
            if (ctx == "liked" || ctx == "__liked__") return NowPlayingFrom(L("PLAYING FROM PLAYLIST"), L("Liked Songs"))
            if (ctx == "radar") return NowPlayingFrom(L("PLAYING FROM PLAYLIST"), L("Release Radar"))
            // The web's genre tiles are `browse:<id>`; the native player names genres `genre:<name>`.
            if (ctx.startsWith("genre:")) {
                val name = ctx.removePrefix("genre:")
                return NowPlayingFrom(L("PLAYING FROM GENRE"), name.ifEmpty { L("Genre") })
            }
            if (ctx.startsWith("browse:")) return NowPlayingFrom(L("PLAYING FROM GENRE"), L("Genre"))
            return null
        }

        /** The id to look up for a library context (`ctxItemId`). */
        fun itemId(ctx: String): String = when {
            ctx.startsWith("artist:") -> ctx.removePrefix("artist:")
            ctx.startsWith("mix:") -> ctx.removePrefix("mix:")
            ctx.startsWith("radio:") -> ctx.removePrefix("radio:")
            else -> ctx
        }

        /** Resolve with the server (`/api/items/:id`, `/api/playlists/:id`). */
        suspend fun resolve(ctx: String?, api: ApiClient?): NowPlayingFrom {
            immediate(ctx)?.let { return it }
            if (ctx == null || api == null) return fallback
            val id = itemId(ctx)
            if (ctx.startsWith("mix:")) {
                // TODO(lead): the Home top-artists list (first 16) to number "Daily Mix {n}" like the web.
                val n = attempt { api.lookup(id) }?.let { field(it.item, "name") }
                return if (n != null) NowPlayingFrom(L("PLAYING FROM PLAYLIST"), L("{name} Mix", "name" to n))
                else NowPlayingFrom(L("PLAYING FROM PLAYLIST"), L("Daily Mix"))
            }
            if (ctx.startsWith("radio:")) {
                // Go to radio's playlist: "<seed> Radio" (Player.jsx).
                val n = if (id.startsWith("pl_")) attempt { api.playlist(id) }?.playlist?.name
                else attempt { api.lookup(id) }?.let { field(it.item, "name") ?: field(it.item, "title") }
                return NowPlayingFrom(L("PLAYING FROM PLAYLIST"), if (n.isNullOrEmpty()) L("Playlist") else L("{name} Radio", "name" to n))
            }
            if (id.startsWith("pl_")) {
                val p = attempt { api.playlist(id) } ?: return fallback
                return NowPlayingFrom(L("PLAYING FROM PLAYLIST"), p.playlist.name)
            }
            val it = attempt { api.lookup(id) } ?: return fallback
            val name = field(it.item, "name") ?: field(it.item, "title") ?: ""
            if (name.isEmpty()) return fallback
            return when (it.kind) {
                ItemKind.Artist -> NowPlayingFrom(L("PLAYING FROM ARTIST"), name)
                ItemKind.Album -> NowPlayingFrom(L("PLAYING FROM ALBUM"), name)
                ItemKind.Track -> NowPlayingFrom(L("PLAYING FROM PLAYLIST"), name)
            }
        }

        private fun field(e: JsonElement, key: String): String? =
            ((e as? JsonObject)?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}
