package com.lukasbaxter.slopify.android.player

import android.net.Uri
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * What the media session (notification, lock screen, Bluetooth / headset buttons, Android
 * Auto) sees: a Media3 Player that only mirrors [SlopifyPlayer] and hands every control back
 * to it (the iOS NowPlayingCenter role). The sound itself comes from [Media3AudioEngine], so
 * crossfade, transfers and mirroring stay in one place.
 */
@OptIn(UnstableApi::class)
class SessionPlayer(private val handlers: LockScreenHandlers) : SimpleBasePlayer(Looper.getMainLooper()), NowPlayingPublishing {
    private var info: LockScreenInfo? = null
    private var cachedQueue: List<*>? = null
    private var cachedItems: List<MediaItemData> = emptyList()

    /** The current song's like state changed (the session updates its heart button). */
    var onLiked: ((Boolean?) -> Unit)? = null
    /** Something is playing here (the platform makes sure the service is up). */
    var onPlaying: (() -> Unit)? = null

    val liked: Boolean? get() = info?.liked

    override fun update(info: LockScreenInfo?) {
        if (info == this.info) return
        val likedBefore = this.info?.liked
        this.info = info
        invalidateState()
        if (info?.liked != likedBefore) onLiked?.invoke(info?.liked)
        if (info?.playing == true) onPlaying?.invoke()
    }

    override fun getState(): State {
        val i = info
        val b = State.Builder().setAvailableCommands(COMMANDS)
        if (i == null || i.queue.isEmpty()) {
            return b.setPlaybackState(STATE_IDLE).setPlayWhenReady(false, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST).build()
        }
        val index = i.index.coerceIn(0, i.queue.size - 1)
        val items = items(i).toMutableList()
        items[index] = current(i, index)
        val state = when {
            !i.loaded && !i.playing -> STATE_IDLE
            i.loading -> STATE_BUFFERING
            else -> STATE_READY
        }
        val pos = (handlers.position() * 1000).toLong()
        return b.setPlaylist(items)
            .setCurrentMediaItemIndex(index)
            .setPlaybackState(state)
            .setPlayWhenReady(i.playing, PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setContentPositionMs(if (i.playing && !i.loading) PositionSupplier.getExtrapolating(pos, 1f) else PositionSupplier.getConstant(pos))
            // Next at the end of the queue starts autoplay and previous restarts the first
            // song; a wrapping playlist keeps both buttons live (the command picks the action).
            .setRepeatMode(REPEAT_MODE_ALL)
            .build()
    }

    /** Every queue row, without art; rebuilt only when the queue list changes. */
    private fun items(i: LockScreenInfo): List<MediaItemData> {
        if (cachedQueue !== i.queue) {
            cachedQueue = i.queue
            cachedItems = i.queue.mapIndexed { k, t ->
                val meta = MediaMetadata.Builder().setTitle(t.title).setArtist(t.creditLine).setAlbumTitle(t.album)
                    .setIsPlayable(true).setIsBrowsable(false).build()
                MediaItemData.Builder("$k:${t.id}")
                    .setMediaItem(MediaItem.Builder().setMediaId(t.id).setMediaMetadata(meta).build())
                    .setDurationUs(if (t.durationMs > 0) t.durationMs * 1000L else C.TIME_UNSET)
                    .setIsSeekable(true)
                    .build()
            }
        }
        return cachedItems
    }

    private fun current(i: LockScreenInfo, index: Int): MediaItemData {
        val meta = MediaMetadata.Builder().setTitle(i.title).setArtist(i.artist).setAlbumTitle(i.album)
            .setArtworkUri(i.artUrl?.let { Uri.parse(it) })
            .setUserRating(androidx.media3.common.HeartRating(i.liked))
            .setIsPlayable(true).setIsBrowsable(false).build()
        return MediaItemData.Builder("$index:${i.id}")
            .setMediaItem(MediaItem.Builder().setMediaId(i.id).setMediaMetadata(meta).build())
            .setDurationUs(if (i.duration > 0) (i.duration * 1_000_000).toLong() else C.TIME_UNSET)
            .setIsSeekable(true)
            .build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
        if (playWhenReady) handlers.play() else handlers.pause()
        return Futures.immediateVoidFuture()
    }

    /** Media buttons on an idle player prepare first: playing loads the song anyway. */
    override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

    override fun handleStop(): ListenableFuture<*> {
        handlers.pause()
        return Futures.immediateVoidFuture()
    }

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        when (seekCommand) {
            Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> handlers.next()
            Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> handlers.previous()
            Player.COMMAND_SEEK_TO_MEDIA_ITEM -> if (mediaItemIndex != info?.index) handlers.skipTo(mediaItemIndex) else handlers.seek(maxOf(0L, positionMs) / 1000.0)
            Player.COMMAND_SEEK_TO_DEFAULT_POSITION -> handlers.seek(0.0)
            else -> handlers.seek(maxOf(0L, positionMs) / 1000.0)
        }
        return Futures.immediateVoidFuture()
    }

    /** From the session's heart button. */
    fun like(want: Boolean) = handlers.like(want)

    companion object {
        private val COMMANDS = Player.Commands.Builder().addAll(
            COMMAND_PLAY_PAUSE, COMMAND_PREPARE, COMMAND_STOP,
            COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, COMMAND_SEEK_TO_MEDIA_ITEM, COMMAND_SEEK_TO_DEFAULT_POSITION,
            COMMAND_GET_CURRENT_MEDIA_ITEM, COMMAND_GET_TIMELINE, COMMAND_GET_METADATA,
        ).build()
    }
}
