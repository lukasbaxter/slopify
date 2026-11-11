package com.lukasbaxter.slopify.android.player

import android.content.ComponentName
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import java.io.File

/** Builds the real player for the app (AppModel.create). */
object AndroidPlayer {
    fun create(context: Context, scope: CoroutineScope): Player =
        SlopifyPlayer(scope, platform = Platform(context.applicationContext, scope))

    private class Platform(private val app: Context, private val scope: CoroutineScope) : SlopifyPlayer.PlayerPlatform {
        private var controller: ListenableFuture<MediaController>? = null

        override fun engine(): AudioEngine = Media3AudioEngine(app, scope)
        override fun audioFocus(): AudioFocusControlling = AndroidAudioFocus(app)

        override fun lockScreen(handlers: LockScreenHandlers): NowPlayingPublishing {
            val p = SessionPlayer(handlers)
            PlaybackBridge.sessionPlayer = p
            p.onPlaying = { ensureService() }
            ensureService()
            return p
        }

        /**
         * A controller bound to [PlaybackService] creates it and its session; Media3 then
         * promotes it to the foreground while something plays. Reconnects if the system
         * stopped the service (task swiped away while paused).
         */
        private fun ensureService() {
            val f = controller
            if (f != null && (!f.isDone || runCatching { f.get().isConnected }.getOrDefault(false))) return
            f?.let { MediaController.releaseFuture(it) }
            controller = MediaController.Builder(app, SessionToken(app, ComponentName(app, PlaybackService::class.java))).buildAsync()
        }

        override fun linkWatch() = LinkWatch(
            cellular = {
                val cm = app.getSystemService(ConnectivityManager::class.java)
                val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
                caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) &&
                    !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
            },
            now = { System.currentTimeMillis().toDouble() },
        )

        override val storageRoot: File get() = app.filesDir
        override val isTablet: Boolean get() = app.resources.configuration.smallestScreenWidthDp >= 600

        override fun onBackground(f: () -> Unit) {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStop(owner: LifecycleOwner) = f()
            })
        }
    }
}
