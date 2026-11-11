package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.artist
import com.lukasbaxter.slopify.android.core.api.await
import com.lukasbaxter.slopify.android.core.api.mix
import com.lukasbaxter.slopify.android.core.api.postPlay
import com.lukasbaxter.slopify.android.core.api.tracks
import com.lukasbaxter.slopify.android.core.api.warm
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.Mix
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.coroutines.delay
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request

/** The REST side the Player uses. [ApiPlayerBackend] wraps the ApiClient; tests use a fake. */
interface PlayerBackend {
    val token: String?
    suspend fun tracks(ids: List<String>): List<Track>
    suspend fun mix(id: String, limit: Int?, mode: String?): Mix
    suspend fun artist(id: String): ArtistDetail
    suspend fun warm(ids: List<String>, profile: String, norm: String?)
    suspend fun postPlay(trackId: String, at: Double?, client: String)
    fun hlsUrl(trackId: String, max: String, norm: String?): String
    fun imageUrl(id: String, size: Int): String
    /**
     * Fetch the start rung of a song's HLS stream (low priority) so a press of play finds it
     * transcoded. Failures are ignored.
     */
    suspend fun prewarm(master: String)
}

class ApiPlayerBackend(private val api: ApiClient) : PlayerBackend {
    override val token: String? get() = api.token
    override suspend fun tracks(ids: List<String>) = api.tracks(ids)
    override suspend fun mix(id: String, limit: Int?, mode: String?) = api.mix(id, limit, mode)
    override suspend fun artist(id: String) = api.artist(id)
    override suspend fun warm(ids: List<String>, profile: String, norm: String?) = api.warm(ids, profile, norm)
    override suspend fun postPlay(trackId: String, at: Double?, client: String) = api.postPlay(trackId, at, client)
    override fun hlsUrl(trackId: String, max: String, norm: String?) = api.hlsUrl(trackId, max, norm).toString()
    override fun imageUrl(id: String, size: Int) = api.imageUrl(id, size).toString()

    /**
     * slopify.js `prewarm`: the master names the start rung first (with any baked gain); its
     * playlist is asked for with `pre=1` (a warm, not a play), retried while still encoding,
     * then its init segment and first two segments.
     */
    override suspend fun prewarm(master: String) {
        suspend fun text(u: String): String? = attempt {
            api.http.newCall(Request.Builder().url(u).build()).await().use { r -> if (r.code == 200) r.body?.string() else null }
        }
        val masterUrl = master.toHttpUrlOrNull() ?: return
        val first = text(master)?.let { HlsPlaylist.variants(it).firstOrNull() } ?: return
        val variantBase = masterUrl.resolve(first) ?: return
        val b = variantBase.newBuilder().removeAllQueryParameters("abr").addQueryParameter("pre", "1")
        val variant = b.build()
        for (attempt in 0 until 4) {
            val pl = text(variant.toString()) ?: return
            if ("#EXT-X-ENDLIST" in pl) {
                for (seg in HlsPlaylist.segments(pl, 2)) {
                    val u = variant.resolve(seg) ?: continue
                    attempt { api.http.newCall(Request.Builder().url(u).build()).await().close() }
                }
                return
            }
            if (attempt < 3) delay(2500)
        }
    }
}

/** Just enough HLS playlist reading for prewarm. */
object HlsPlaylist {
    /** Variant URIs of a master playlist, in order. */
    fun variants(master: String): List<String> = lines(master).filter { !it.startsWith("#") }

    /** The init segment (fMP4) and the first `count` media segments of a variant playlist. */
    fun segments(playlist: String, count: Int): List<String> {
        val ls = lines(playlist)
        val out = mutableListOf<String>()
        ls.firstOrNull { it.startsWith("#EXT-X-MAP:") }?.let { map ->
            Regex("URI=\"([^\"]+)\"").find(map)?.groupValues?.get(1)?.let { out += it }
        }
        val seg = Regex("^s\\d+\\.(ts|m4s)(\\?\\S*)?$")
        out += ls.filter { seg.matches(it) }.take(count)
        return out
    }

    private fun lines(s: String) = s.lines().map { it.trim() }.filter { it.isNotEmpty() }
}
