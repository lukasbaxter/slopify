package com.lukasbaxter.slopify.android.features.widget

import android.content.ComponentName
import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.lukasbaxter.slopify.android.app.SlopifyApplication
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.player.PlaybackService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A widget button was tapped (a broadcast: the app does not open). */
internal class WidgetTransportAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val command = WidgetCommand.of(parameters[COMMAND]) ?: return
        WidgetTransport.send(context.applicationContext, command)
    }

    companion object {
        val COMMAND = ActionParameters.Key<String>("command")
    }
}

internal object WidgetTransport {
    /**
     * Through the media session, as the notification's buttons go: a controller bound to
     * [PlaybackService] brings the service and its session up when they are not (the way the
     * player itself does), and the session hands the command to the player. In a process the
     * tap just started, the application has already built the player by now.
     */
    suspend fun send(app: Context, command: WidgetCommand) = withContext(Dispatchers.Main) {
        // A new process reads its queue back from disk a moment after it starts: wait for the song.
        val player = (app as? SlopifyApplication)?.model?.player
        if (player != null) withTimeoutOrNull(2000) { player.state.first { it.current != null } }
        val future = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        try {
            // No session (the service refused): nothing to control, and a tap must never crash.
            val controller = withTimeoutOrNull(5000) { attempt { future.await() } } ?: return@withContext
            when (command) {
                WidgetCommand.Toggle -> if (controller.playWhenReady) controller.pause() else controller.play()
                WidgetCommand.Next -> controller.seekToNext()
                WidgetCommand.Previous -> controller.seekToPrevious()
            }
        } finally {
            MediaController.releaseFuture(future)
        }
    }

    private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { c ->
        addListener({
            try { c.resume(get()) } catch (e: Exception) { c.resumeWithException(e) }
        }, MoreExecutors.directExecutor())
    }
}
