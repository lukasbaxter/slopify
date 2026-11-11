package com.lukasbaxter.slopify.android.app

import android.content.Context
import android.os.Build
import android.provider.Settings
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.core.auth.AndroidNetworkMonitor
import com.lukasbaxter.slopify.android.core.auth.NetworkMonitor
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.session.OkHttpSocket
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.session.SocketTransport
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import com.lukasbaxter.slopify.android.core.storage.KeystoreSecureStore
import com.lukasbaxter.slopify.android.core.storage.SecureStore
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import com.lukasbaxter.slopify.android.core.stores.Likes
import com.lukasbaxter.slopify.android.core.stores.LyricJobStore
import com.lukasbaxter.slopify.android.player.NoopPlayer
import com.lukasbaxter.slopify.android.player.Player
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.TimeUnit

/**
 * Owns the long-lived objects and wires them together (ios App/AppModel.swift). One per
 * process, created by [SlopifyApplication]; screens get it from `LocalAppModel`.
 */
class AppModel(
    private val scope: CoroutineScope,
    secureStore: SecureStore,
    kv: KeyValueStore,
    network: NetworkMonitor?,
    deviceName: String,
    form: String,
    makeSocket: ((String) -> SocketTransport)? = null,
    val player: Player = NoopPlayer(),
) {
    val connectivity = Connectivity(scope)
    val account = Account(secureStore, connectivity, network, scope, deviceName)
    val session = SessionClient(
        scope, kv, deviceName, form,
        makeSocket ?: { url -> OkHttpSocket(account.api.http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build(), url) },
    )
    val likes = Likes()
    val nav = Navigator()
    val lyricJobs = LyricJobStore(scope)

    private val libraryChangedFlow = MutableSharedFlow<Prefs?>(extraBufferCapacity = 8)
    /**
     * Playlists / layout changed on another device: re-fetch the library. Carries the socket's
     * prefs patch (so a store can skip its own layout rev), or null.
     */
    val libraryChanged: SharedFlow<Prefs?> = libraryChangedFlow.asSharedFlow()

    private var started = false

    init {
        account.onBaseChanged = { base -> session.move(base) }
        account.onPrefsPatched = { patch -> session.sendPrefs(patch) }
        session.onLike = { id, liked -> likes.remote(id, liked) }
        session.onPrefs = { patch ->
            account.applyRemotePrefs(patch)
            if (patch.containsKey("_libraryLayout") || patch.containsKey("_libraryChanged")) libraryChangedFlow.tryEmit(patch)
        }
        session.onSignedOut = { account.signedOutBySession() }
        likes.attach(account.api)
        player.likes = likes
        player.attach(account, session)
        // Follows sign-in itself: resumes this account's unfinished jobs, forgets them on sign-out.
        lyricJobs.attach(account)
        scope.launch {
            account.state.collect { s ->
                when (s) {
                    AccountState.SignedIn -> start()
                    AccountState.SignedOut -> stop()
                    AccountState.PasswordChange -> Unit
                }
            }
        }
    }

    /** Tell other devices this one changed the library (prefs signal). */
    fun libraryChangedHere() = session.sendPrefs(mapOf("_libraryChanged" to JsonPrimitive(System.currentTimeMillis())))

    /** Signed in: on launch, after sign-in, and on every foreground. */
    suspend fun start() {
        if (account.state.value != AccountState.SignedIn) return
        val token = account.api.token ?: return
        val base = account.activeBase.value
        if (!started && base != null) {
            started = true
            session.connect(base, token)
        }
        account.refreshAfterSignIn()
        likes.refresh()
    }

    /** Signed out: nothing of the last account stays in memory (App.jsx `signOut`). */
    fun stop() {
        started = false
        session.disconnect()
        nav.reset()
        likes.reset()
        connectivity.reset()
    }

    /** The process came to the foreground. */
    fun foreground() {
        session.onForeground()
        scope.launch { start() }
    }

    /** The process went to the background. */
    fun background() = session.onBackground()

    companion object {
        fun create(context: Context, scope: CoroutineScope): AppModel {
            val app = context.applicationContext
            return AppModel(
                scope = scope,
                secureStore = KeystoreSecureStore(app),
                kv = SharedPrefsStore(app),
                network = AndroidNetworkMonitor(app),
                deviceName = deviceName(app),
                form = if (app.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone",
            )
        }

        /** The name the owner gave the phone, else its model. */
        fun deviceName(context: Context): String =
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
                ?: Build.MODEL

    }
}
