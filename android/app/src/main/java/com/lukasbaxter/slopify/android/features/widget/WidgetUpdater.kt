package com.lukasbaxter.slopify.android.features.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import com.lukasbaxter.slopify.android.app.AppModel
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.design.color.ArtworkColor
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.ImageLoader
import com.lukasbaxter.slopify.android.features.home.HomeSnapshot
import com.lukasbaxter.slopify.android.features.home.HomeStore
import com.lukasbaxter.slopify.android.features.nowplaying.NowPlayingCover
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Keeps the home screen widgets on the player and on Home's shortcuts: every change lands in
 * the [WidgetStore] (state + pictures on disk) and the placed widgets redraw from it.
 */
object WidgetUpdater {
    private data class Now(val id: String, val title: String, val artist: String, val cover: CoverSource, val playing: Boolean)

    /** Once per process (the application calls it). */
    fun start(context: Context, model: AppModel) {
        val app = context.applicationContext
        val store = WidgetStore.shared(app)
        val scope = model.scope

        scope.launch {
            model.account.state.collect {
                if (it == AccountState.SignedOut) { store.clear(); redraw(app) }
            }
        }

        // The song and whether it plays.
        scope.launch {
            model.player.state
                .map { s -> s.current?.let { Now(it.id, it.title, it.creditLine, NowPlayingCover.source(it), s.isPlaying) } }
                .distinctUntilChanged()
                .collectLatest { now ->
                    if (now == null) {
                        // A new process has no queue for a moment (it comes back from disk): keep the kept song.
                        if (model.account.state.value == AccountState.SignedIn) delay(2000)
                        store.update { it.copy(track = null, playing = false, color = null) }
                        store.setProgress(null)
                        store.prune()
                    } else {
                        show(app, model, store, now)
                    }
                    redraw(app)
                }
        }

        // Home's shortcuts, whenever Home has loaded them (an empty store is one that has not).
        scope.launch {
            HomeStore.shared.state
                .map { it.data }
                .filter { it != HomeSnapshot() }
                .map { WidgetLogic.tiles(it.shortcuts) }
                .distinctUntilChanged()
                .collectLatest { tiles ->
                    val done = tiles.map { t ->
                        val source = WidgetLogic.coverSource(t)
                        t.copy(cover = source?.let { picture(model, store, it, WidgetLogic.TILE_PX) })
                    }
                    store.update { it.copy(tiles = done) }
                    store.prune()
                    redraw(app)
                }
        }

        // The small widget's progress line.
        scope.launch {
            model.player.progress
                .map { WidgetLogic.progressStep(WidgetLogic.progress(it.position, it.duration)) }
                .distinctUntilChanged()
                .collect { p ->
                    if (store.snapshot.value.track == null) return@collect
                    store.setProgress(p)
                    attempt { SmallWidget().updateAll(app) }
                }
        }
    }

    private suspend fun show(app: Context, model: AppModel, store: WidgetStore, now: Now) {
        val name = WidgetLogic.fileName(now.cover)
        val shown = store.snapshot.value.track
        if (shown?.id == now.id && shown.cover == name) {
            store.update { it.copy(track = WidgetTrack(now.id, now.title, now.artist, name), playing = now.playing) }
            return
        }
        if (!store.file(name).exists()) {
            // The words now; the picture and its colour follow.
            store.update { it.copy(track = WidgetTrack(now.id, now.title, now.artist, null), playing = now.playing) }
            redraw(app)
        }
        val cover = picture(model, store, now.cover, WidgetLogic.COVER_PX)
        // The colour now playing uses, from the same picture.
        val color = attempt { ArtworkColor.shared.vibrant(now.cover.url(model.account.api, 320)) }
        store.update { it.copy(track = WidgetTrack(now.id, now.title, now.artist, cover), playing = now.playing, color = color?.ints) }
        store.prune()
    }

    /** The cover saved in the widget folder (fetched once): its file name, or null when it cannot be had. */
    private suspend fun picture(model: AppModel, store: WidgetStore, source: CoverSource, px: Int): String? {
        val name = WidgetLogic.fileName(source)
        val file = store.file(name)
        return withContext(Dispatchers.IO) {
            if (file.exists()) return@withContext name
            val url = attempt { source.url(model.account.api, 320) } ?: return@withContext null
            val bytes = ImageLoader.shared.data(url) ?: return@withContext null
            if (WidgetBitmaps.save(bytes, px, file)) name else null
        }
    }

    /** Every placed widget draws again (starts its session when none runs). */
    private suspend fun redraw(app: Context) {
        attempt { RecentsWidget().updateAll(app) }
        attempt { PlayerWidget().updateAll(app) }
        attempt { SmallWidget().updateAll(app) }
    }
}
