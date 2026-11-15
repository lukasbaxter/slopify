package com.lukasbaxter.slopify.android.features.widget

import com.lukasbaxter.slopify.android.app.Route
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/**
 * Where a widget tap lands in the app, as a `slopify://widget/...` link on the activity's
 * intent (each tile gets its own link, so their pending intents never collapse into one).
 */
object WidgetLink {
    private const val SCHEME = "slopify"
    private const val HOST = "widget"

    const val NOW_PLAYING = "$SCHEME://$HOST/now-playing"

    sealed interface Target {
        data object NowPlaying : Target
        data class Page(val route: Route) : Target
    }

    /** `kind`: album | playlist | artist. */
    fun tile(kind: String, id: String): String = "$SCHEME://$HOST/$kind/${URLEncoder.encode(id, "UTF-8")}"

    /** Null for anything that is not a widget link (invite links share the scheme). */
    fun parse(url: String?): Target? {
        val u = url?.let { runCatching { URI(it.trim()) }.getOrNull() } ?: return null
        if (u.scheme?.lowercase() != SCHEME || u.host != HOST) return null
        val parts = u.rawPath.orEmpty().trim('/').split('/')
        if (parts.size == 1 && parts[0] == "now-playing") return Target.NowPlaying
        if (parts.size != 2) return null
        val id = runCatching { URLDecoder.decode(parts[1], "UTF-8") }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
        return when (parts[0]) {
            "album" -> Target.Page(Route.Album(id))
            "playlist" -> Target.Page(Route.Playlist(id))
            "artist" -> Target.Page(Route.Artist(id))
            else -> null
        }
    }
}
