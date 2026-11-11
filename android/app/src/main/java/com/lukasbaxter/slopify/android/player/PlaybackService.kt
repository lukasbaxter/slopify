package com.lukasbaxter.slopify.android.player

import android.app.PendingIntent
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.lukasbaxter.slopify.android.design.L

/**
 * The media session's home: foreground service (type mediaPlayback) with the playback
 * notification, lock screen controls, Bluetooth / headset buttons and an Android Auto
 * browse root (a stub: the car shows the now-playing queue). The player it serves is the
 * app's [SessionPlayer]; this service never owns or releases it.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {
    private var session: MediaLibrarySession? = null

    override fun onCreate() {
        super.onCreate()
        val player = PlaybackBridge.sessionPlayer ?: return
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val b = MediaLibrarySession.Builder(this, player, Callback(player))
        if (launch != null) b.setSessionActivity(launch)
        val s = b.build()
        session = s
        s.setMediaButtonPreferences(buttons(player.liked))
        player.onLiked = { liked -> session?.setMediaButtonPreferences(buttons(liked)) }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    override fun onDestroy() {
        PlaybackBridge.sessionPlayer?.onLiked = null
        session?.release()
        session = null
        super.onDestroy()
    }

    private class Callback(private val player: SessionPlayer) : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon().add(LIKE).add(UNLIKE).build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(commands)
                .setMediaButtonPreferences(buttons(player.liked))
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession, controller: MediaSession.ControllerInfo, customCommand: SessionCommand, args: Bundle,
        ): ListenableFuture<SessionResult> {
            val ok = when (customCommand.customAction) {
                LIKE.customAction -> player.like(true)
                UNLIKE.customAction -> player.like(false)
                else -> false
            }
            return Futures.immediateFuture(SessionResult(if (ok) SessionResult.RESULT_SUCCESS else SessionError.ERROR_NOT_SUPPORTED))
        }

        override fun onGetLibraryRoot(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> = Futures.immediateFuture(LibraryResult.ofItem(ROOT, params))

        override fun onGetItem(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String,
        ): ListenableFuture<LibraryResult<MediaItem>> = Futures.immediateFuture(
            if (mediaId == ROOT.mediaId) LibraryResult.ofItem(ROOT, null) else LibraryResult.ofError(SessionError.ERROR_BAD_VALUE),
        )

        override fun onGetChildren(
            session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.of(), params))
    }

    companion object {
        private val LIKE = SessionCommand("slopify.like", Bundle.EMPTY)
        private val UNLIKE = SessionCommand("slopify.unlike", Bundle.EMPTY)

        private val ROOT: MediaItem = MediaItem.Builder()
            .setMediaId("root")
            .setMediaMetadata(MediaMetadata.Builder().setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build())
            .build()

        /** The heart, filled when the current song is liked. Hidden with nothing playing. */
        private fun buttons(liked: Boolean?): List<CommandButton> {
            if (liked == null) return emptyList()
            val b = if (liked) {
                CommandButton.Builder(CommandButton.ICON_HEART_FILLED).setDisplayName(L("Remove from Liked Songs")).setSessionCommand(UNLIKE)
            } else {
                CommandButton.Builder(CommandButton.ICON_HEART_UNFILLED).setDisplayName(L("Add to Liked Songs")).setSessionCommand(LIKE)
            }
            return listOf(b.setSlots(CommandButton.SLOT_OVERFLOW).build())
        }
    }
}

/** Hands the app's SessionPlayer to the service the system creates. */
internal object PlaybackBridge {
    @Volatile var sessionPlayer: SessionPlayer? = null
}
