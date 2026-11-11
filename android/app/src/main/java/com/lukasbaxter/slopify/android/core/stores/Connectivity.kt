package com.lukasbaxter.slopify.android.core.stores

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * App-wide "offline" (web offline/net.js): the phone has no network path, or the server could
 * not be reached and a health check confirms it. While offline the health check runs every
 * 15 s; its first answer, or any live API answer, ends it. Screens read [offline].
 */
class Connectivity(private val scope: CoroutineScope) {
    private val state = MutableStateFlow(false)
    val offline: StateFlow<Boolean> = state.asStateFlow()

    /** `GET /api/healthz` on the address in use, within the timeout (seconds). Set by Account. */
    @Volatile var healthCheck: (suspend (Double) -> Boolean)? = null
    /** Called on every change. */
    @Volatile var onChange: ((Boolean) -> Unit)? = null
    var retryInterval: Duration = 15.seconds
    var confirmTimeout: Double = 4.0

    private val lock = Any()
    private var confirming: Job? = null
    private var retrying: Job? = null

    /** From the network monitor: no path is offline at once; a path back is checked first. */
    fun pathChanged(satisfied: Boolean) {
        if (!satisfied) goOffline() else if (state.value) scope.launch { check(8.0) }
    }

    /**
     * After every request: an answer ends offline; a failed connect is confirmed first, so one
     * failure on a jittery link does not flip the whole app.
     */
    fun note(reachable: Boolean) {
        if (reachable) goOnline() else confirm()
    }

    /** Signed out: nothing to be offline from. */
    fun reset() = goOnline()

    private fun confirm() {
        synchronized(lock) {
            if (confirming != null || state.value) return
            confirming = scope.launch {
                val ok = healthCheck?.invoke(confirmTimeout) ?: false
                synchronized(lock) { confirming = null }
                if (!ok) goOffline()
            }
        }
    }

    private suspend fun check(timeout: Double): Boolean {
        val ok = healthCheck?.invoke(timeout) ?: false
        if (ok) goOnline()
        return ok
    }

    private fun goOffline() {
        synchronized(lock) {
            if (state.value) return
            state.value = true
            retrying?.cancel()
            retrying = scope.launch {
                while (isActive && state.value) {
                    delay(retryInterval)
                    if (!isActive) return@launch
                    check(8.0)
                }
            }
        }
        onChange?.invoke(true)
    }

    private fun goOnline() {
        synchronized(lock) {
            retrying?.cancel(); retrying = null
            if (!state.value) return
            state.value = false
        }
        onChange?.invoke(false)
    }
}
