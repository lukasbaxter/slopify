package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.artist
import com.lukasbaxter.slopify.android.core.api.artistPopular
import com.lukasbaxter.slopify.android.core.api.discography
import com.lukasbaxter.slopify.android.core.api.requestAlbum
import com.lukasbaxter.slopify.android.core.api.similar
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.EverywhereResults
import com.lukasbaxter.slopify.android.core.model.Release
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/** The artist page's discography load. */
sealed interface DetailDiscog {
    data object Loading : DetailDiscog
    data class Loaded(val releases: List<Release>) : DetailDiscog
    data object Failed : DetailDiscog
}

/** Artist page data (App.jsx openArtistById + Library.jsx discography / similar / requests; ios DetailArtistModel.swift). */
class DetailArtistModel(val id: String, private val io: CoroutineDispatcher = Dispatchers.IO) {
    var artist by mutableStateOf<Artist?>(null); private set
    var followed by mutableStateOf(false)
    var albums by mutableStateOf<List<Album>>(emptyList()); private set
    var appearsOn by mutableStateOf<List<Album>>(emptyList()); private set
    /** In popular order once known. */
    var tracks by mutableStateOf<List<Track>>(emptyList()); private set
    var loading by mutableStateOf(true); private set
    var sampled by mutableStateOf<RGB?>(null); private set
    var discog by mutableStateOf<DetailDiscog>(sessionDiscog[id]?.let { DetailDiscog.Loaded(it) } ?: DetailDiscog.Loading); private set
    var similar by mutableStateOf(sessionSimilar[id] ?: emptyList()); private set
    /** album_id -> this client's request state (queued | exists | error). */
    var requesting by mutableStateOf<Map<String, String>>(emptyMap()); private set
    /** Optimistic follow while the request runs. */
    var followOverride by mutableStateOf<Boolean?>(null)

    private var popular: List<String> = emptyList()

    val context: String get() = "artist:$id"
    val hero: RGB get() = ColorMath.detailHero(sampled = sampled, isArtist = true)
    /** `bannerUrl(item)`: the wide photo, else the portrait; false = flat hero. */
    val hasBanner: Boolean get() = artist?.banner != null || artist?.image != null

    val entries: List<DetailLogic.Entry>
        get() = DetailLogic.entries((discog as? DetailDiscog.Loaded)?.releases ?: emptyList(), albums)

    suspend fun load(api: ApiClient, scope: String?, cache: DetailCache) = coroutineScope {
        val key = "ar.$id"
        withContext(io) { cache.load(key, scope, DetailArtistPage.serializer()) }?.let { kept ->
            apply(kept.detail)
            popular = kept.popular ?: emptyList()
            tracks = DetailLogic.popularOrder(kept.detail.tracks, popular)
            loading = false
        }
        val disco = if (discog !is DetailDiscog.Loaded) async { loadDiscography(api) } else null
        val sim = if (similar.isEmpty()) async { loadSimilar(api) } else null
        try {
            val d = api.artist(id)
            apply(d)
            tracks = DetailLogic.popularOrder(d.tracks, popular)
            loading = false
            withContext(io) { cache.save(DetailArtistPage(d, popular.ifEmpty { null }), key, scope, DetailArtistPage.serializer()) }
            val ids = attempt { api.artistPopular(id) }
            if (!ids.isNullOrEmpty()) {
                popular = ids
                tracks = DetailLogic.popularOrder(d.tracks, ids)
                withContext(io) { cache.save(DetailArtistPage(d, ids), key, scope, DetailArtistPage.serializer()) }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            loading = false
        }
        disco?.await()
        sim?.await()
        Unit
    }

    private fun apply(d: ArtistDetail) {
        artist = d.artist; followed = d.followed; albums = d.albums; appearsOn = d.appearsOn
    }

    suspend fun sampleColour(api: ApiClient) {
        sampled = ArtworkColor.shared.vibrant(api.imageUrl(id, 120).toString())
    }

    suspend fun loadDiscography(api: ApiClient) {
        discog = DetailDiscog.Loading
        discog = attempt { api.discography(id) }?.let { d ->
            sessionDiscog[id] = d.releases
            DetailDiscog.Loaded(d.releases)
        } ?: DetailDiscog.Failed
    }

    private suspend fun loadSimilar(api: ApiClient) {
        val s = attempt { api.similar(id) } ?: return
        similar = s
        sessionSimilar[id] = s
    }

    // Requests

    fun requestState(e: DetailLogic.Entry): String? = DetailLogic.requestState(e.mbid?.let { requesting[it] }, e.requestStatus)

    /** Any missing release on its way: poll the discography until it lands. */
    val hasPending: Boolean
        get() = entries.any { e -> e.inLib == null && requestState(e)?.let { it in DetailLogic.pending } == true }

    suspend fun request(e: DetailLogic.Entry, api: ApiClient) {
        val mbid = e.mbid ?: return
        requesting = requesting + (mbid to "queued")
        try {
            val st = api.requestAlbum(mbid) ?: "queued"
            requesting = requesting + (mbid to st)
            (discog as? DetailDiscog.Loaded)?.let { d ->
                val rels = d.releases.map { if (it.albumId == mbid) it.copy(requestStatus = st) else it }
                discog = DetailDiscog.Loaded(rels)
                sessionDiscog[id] = rels
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            requesting = requesting + (mbid to "error")
            throw e
        }
    }

    /** One quiet re-read while a request is pending (no loading state, errors ignored). */
    suspend fun refreshDiscography(api: ApiClient) {
        val d = attempt { api.discography(id) } ?: return
        discog = DetailDiscog.Loaded(d.releases)
        sessionDiscog[id] = d.releases
    }

    companion object {
        // Kept for the session (Library.jsx component state), keyed by artist id.
        private val sessionDiscog = java.util.concurrent.ConcurrentHashMap<String, List<Release>>()
        private val sessionSimilar = java.util.concurrent.ConcurrentHashMap<String, List<EverywhereResults.ArtistHit>>()

        /** Tests start clean. */
        internal fun forgetSession() { sessionDiscog.clear(); sessionSimilar.clear() }
    }
}
