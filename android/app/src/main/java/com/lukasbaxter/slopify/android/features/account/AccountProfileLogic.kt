package com.lukasbaxter.slopify.android.features.account

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Profile page data (web App.jsx:938-955 `openProfile`, UI.md 7.4.4). */
internal object AccountProfileLogic {
    data class TopArtist(val id: String, val name: String, val score: Int)

    /** Artists of the top tracks, each scored `sum(1 + playCount)`, best 16. Ties keep first-seen order. */
    fun topArtists(tracks: List<Track>, limit: Int = 16): List<TopArtist> {
        val by = LinkedHashMap<String, TopArtist>()
        for (t in tracks) {
            val w = 1 + (t.plays ?: 0)
            for (c in t.artistCredits) {
                val id = c.id?.takeIf { it.isNotEmpty() } ?: continue
                val cur = by[id] ?: TopArtist(id, c.name, 0)
                by[id] = cur.copy(score = cur.score + w)
            }
        }
        // sortedByDescending is stable: equal scores stay in first-seen order.
        return by.values.sortedByDescending { it.score }.take(limit)
    }

    /** `'1 public playlist'` / `'{n} public playlists'`. */
    fun playlistCount(n: Int): String = if (n == 1) L("1 public playlist") else L("{n} public playlists", "n" to n)

    /** First letter, uppercased, or "?". */
    fun initial(name: String?): String {
        if (name.isNullOrEmpty()) return "?"
        return name.substring(0, name.offsetByCodePoints(0, 1)).uppercase()
    }
}

/**
 * Photo bytes for the avatar upload: any picked image re-encoded as JPEG, at most 1024 px on the
 * long side (the server keeps one 512 px rendition, API.md §3.3; HEIC is not among its types).
 * ImageDecoder applies the EXIF rotation.
 */
internal object AccountProfilePhoto {
    const val MAX_SIDE = 1024

    /** The decoded size for a `w x h` source: scaled down to fit [maxSide], never up. */
    fun target(w: Int, h: Int, maxSide: Int = MAX_SIDE): Pair<Int, Int> {
        if (w <= 0 || h <= 0) return 0 to 0
        val scale = min(1.0, maxSide.toDouble() / max(w, h))
        return max(1, (w * scale).roundToInt()) to max(1, (h * scale).roundToInt())
    }

    /** Null when the file is not an image. Blocking: call off the main thread. */
    fun jpeg(resolver: ContentResolver, uri: Uri): ByteArray? = runCatching {
        val source = ImageDecoder.createSource(resolver, uri)
        val bmp = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            val (w, h) = target(info.size.width, info.size.height)
            decoder.setTargetSize(w, h)
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 90, out)
        bmp.recycle()
        out.toByteArray().takeIf { it.isNotEmpty() }
    }.getOrNull()
}
