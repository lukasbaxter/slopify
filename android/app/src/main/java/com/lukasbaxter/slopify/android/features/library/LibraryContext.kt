package com.lukasbaxter.slopify.android.features.library

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.stores.LibraryStore
import com.lukasbaxter.slopify.android.core.model.asArray
import com.lukasbaxter.slopify.android.core.model.asString
import com.lukasbaxter.slopify.android.design.components.TrackMenu
import com.lukasbaxter.slopify.android.design.components.TrackMenuBuilder
import com.lukasbaxter.slopify.android.player.ShuffleMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream

/** Everything the library screens act on (ios LibraryContext.swift). */
internal class LibraryContext(val app: AppModel, val store: LibraryStore, private val context: Context, val scope: CoroutineScope) {
    val player get() = app.player
    val nav get() = app.nav
    val offline: Boolean get() = app.connectivity.offline.value

    fun pinned(prefs: Prefs = app.account.prefs.value): List<String> = pinnedOf(prefs)

    fun togglePin(id: String) {
        val next = LibraryArrangement.togglingPin(pinned(), id)
        scope.launch { app.account.patchPrefs(mapOf("libraryPinned" to JsonArray(next.map(::JsonPrimitive)))) }
    }

    /**
     * Play `tracks` from `index`, or toggle when that row is already the current track.
     * TODO(lead): offline only downloaded songs play (the offline store filters the list) once it exists.
     */
    fun play(tracks: List<Track>, index: Int, context: String) {
        if (index !in tracks.indices) return
        val s = player.state.value
        if (s.current?.id == tracks[index].id && s.context == context) { player.togglePlay(); return }
        player.play(tracks, index, context)
    }

    /** The detail-page play button: toggle when this page is the playing context. */
    fun playPage(tracks: List<Track>, context: String) {
        val s = player.state.value
        if (s.context == context && s.current != null) { player.togglePlay(); return }
        if (tracks.isEmpty()) return
        player.play(tracks, 0, context)
    }

    fun toggleShuffle() = player.setShuffle(if (player.state.value.shuffle == ShuffleMode.Off) ShuffleMode.On else ShuffleMode.Off)

    /** Share link `{main address}/?{kind}={id}` (UI.md 5.4.6). */
    fun share(kind: TrackMenu.ShareKind, id: String, title: String, by: String?) =
        TrackMenuBuilder.share(context, app.account, kind, id, title, by)

    /** A picked photo as JPEG 0.9 (the iOS `jpegData(compressionQuality: 0.9)`). */
    suspend fun jpeg(uri: Uri): ByteArray? = withContext(Dispatchers.IO) {
        val bmp = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return@withContext null
        ByteArrayOutputStream().use { out -> bmp.compress(Bitmap.CompressFormat.JPEG, 90, out); out.toByteArray() }
    }

    companion object {
        fun pinnedOf(prefs: Prefs): List<String> = prefs["libraryPinned"].asArray()?.mapNotNull { it.asString() } ?: emptyList()
    }
}

@Composable
internal fun rememberLibraryContext(): LibraryContext {
    val app = LocalAppModel.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember(app, context, scope) { LibraryContext(app, app.library, context, scope) }
}
