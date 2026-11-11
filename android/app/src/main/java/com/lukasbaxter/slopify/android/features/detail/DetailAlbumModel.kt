package com.lukasbaxter.slopify.android.features.detail

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.api.album
import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.AlbumDetail
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.color.ColorMath
import com.lukasbaxter.slopify.android.design.theme.RGB
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/** Album page data (App.jsx openAlbumById; ios DetailAlbumModel.swift): paint the kept copy, then refresh. */
class DetailAlbumModel(val id: String, private val io: CoroutineDispatcher = Dispatchers.IO) {
    var album by mutableStateOf<Album?>(null); private set
    var tracks by mutableStateOf<List<Track>>(emptyList()); private set
    var loading by mutableStateOf(true); private set
    var loadFailed by mutableStateOf(false); private set
    var failedOffline by mutableStateOf(false); private set
    /** The cover's vibrant colour (raw), once sampled. */
    var sampled by mutableStateOf<RGB?>(null); private set

    val hero: RGB get() = ColorMath.detailHero(sampled = sampled)

    suspend fun load(api: ApiClient, scope: String?, cache: DetailCache) {
        val key = "al.$id"
        withContext(io) { cache.load(key, scope, AlbumDetail.serializer()) }?.let { kept ->
            album = kept.album; tracks = kept.tracks; loading = false
        }
        val hadKept = album != null
        try {
            val d = api.album(id)
            album = d.album; tracks = d.tracks; loading = false; loadFailed = false
            withContext(io) { cache.save(d, key, scope, AlbumDetail.serializer()) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            loading = false
            loadFailed = !hadKept
            failedOffline = e is ApiError.Offline
        }
    }

    suspend fun sampleColour(api: ApiClient) {
        sampled = ArtworkColor.shared.vibrant(api.imageUrl(id, 120).toString())
    }

    /** The placeholder note under an empty list (UI.md 6.3.4). */
    val emptyNote: String?
        get() {
            if (tracks.isNotEmpty() || loading) return null
            if (loadFailed) {
                return if (failedOffline) L("Not available offline. Open it once with a connection, or download it.")
                else L("Couldn’t load this — try again.")
            }
            return L("This album is empty.")
        }
}
