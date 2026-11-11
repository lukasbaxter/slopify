package com.lukasbaxter.slopify.android.core.auth

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.changePassword
import com.lukasbaxter.slopify.android.core.api.demoSignIn
import com.lukasbaxter.slopify.android.core.api.healthzOK
import com.lukasbaxter.slopify.android.core.api.login
import com.lukasbaxter.slopify.android.core.api.logout
import com.lukasbaxter.slopify.android.core.api.me
import com.lukasbaxter.slopify.android.core.api.patchPrefs
import com.lukasbaxter.slopify.android.core.api.prefs
import com.lukasbaxter.slopify.android.core.api.register
import com.lukasbaxter.slopify.android.core.api.serverAddresses
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.LoginResponse
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.User
import com.lukasbaxter.slopify.android.core.storage.SecureStore
import com.lukasbaxter.slopify.android.core.storage.loadJson
import com.lukasbaxter.slopify.android.core.storage.saveJson
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

enum class AccountState { SignedOut, PasswordChange, SignedIn }

/**
 * The signed-in account: server addresses, token, user, prefs. Owns the [ApiClient] and moves
 * it between the main and the home address (API.md §4.4) when the network changes.
 *
 * Call from the main thread (the app's scope); flows are safe to read anywhere.
 */
class Account(
    private val store: SecureStore,
    private val connectivity: Connectivity,
    private val network: NetworkMonitor?,
    private val scope: CoroutineScope,
    /** This phone's name for the server's device list (Settings > About > Device name). */
    val deviceName: String,
    val api: ApiClient = ApiClient(UNSET_BASE),
    /** The home proof; tests swap it. */
    private val homeCheck: suspend (home: String, userId: String, keyHex: String) -> Boolean = { home, uid, key ->
        HomeProof.check(api.http, home, uid, key, HOME_PROOF_TIMEOUT)
    },
) {
    /** What is kept between launches (secure storage). Addresses are normalised strings. */
    @Serializable
    data class Saved(
        val main: String,
        val home: String? = null,
        val homeAuto: Boolean = true,
        val homeOff: Boolean = false,
        val token: String,
        val user: User,
        /** `/api/server/addresses` key, for the home proof. */
        val key: String? = null,
        val demo: Boolean = false,
    )

    private val stateFlow = MutableStateFlow(AccountState.SignedOut)
    private val userFlow = MutableStateFlow<User?>(null)
    private val savedFlow = MutableStateFlow<Saved?>(null)
    private val activeBaseFlow = MutableStateFlow<String?>(null)
    private val prefsFlow = MutableStateFlow<Prefs>(emptyMap())

    val state: StateFlow<AccountState> = stateFlow.asStateFlow()
    val user: StateFlow<User?> = userFlow.asStateFlow()
    val saved: StateFlow<Saved?> = savedFlow.asStateFlow()
    /** Base the app is using right now (main or home). */
    val activeBase: StateFlow<String?> = activeBaseFlow.asStateFlow()
    /** Shallow prefs object (API.md §16). Unknown keys are kept. */
    val prefs: StateFlow<Prefs> = prefsFlow.asStateFlow()

    val onHome: Boolean get() = savedFlow.value?.home != null && activeBaseFlow.value == savedFlow.value?.home

    /** Called after the base URL moves (the session reconnects there). */
    var onBaseChanged: ((String) -> Unit)? = null
    /** Called after a prefs patch from this device, to relay it on the socket. */
    var onPrefsPatched: ((Prefs) -> Unit)? = null

    private val choosing = Mutex()

    init {
        api.onUnauthorized = { clear() }
        api.onPasswordChangeRequired = { stateFlow.value = AccountState.PasswordChange }
        store.loadJson(STORE_KEY, Saved.serializer())?.let { s ->
            savedFlow.value = s; userFlow.value = s.user
            api.baseUrl = s.main; api.token = s.token; activeBaseFlow.value = s.main
            stateFlow.value = if (s.user.mustChangePassword == true) AccountState.PasswordChange else AccountState.SignedIn
        }
        api.onReachability = { connectivity.note(it) }
        connectivity.healthCheck = { timeout ->
            activeBaseFlow.value?.let { ApiClient(it, http = api.http).healthzOK(timeout) } ?: false
        }
        network?.let { n ->
            scope.launch {
                n.path.filterNotNull().collect { p ->
                    connectivity.pathChanged(p.satisfied)
                    chooseAddress()
                }
            }
        }
    }

    // Sign in / out

    /** Finds a Slopify server at what the user typed: every scheme guess probed in parallel. */
    suspend fun findServer(typed: String, timeout: Double = MAIN_PROBE_TIMEOUT): String? =
        findServer(typed, timeout) { url, t -> ApiClient(url, http = api.http).healthzOK(t) }

    /**
     * Signs in through `base`. `main` is the address to keep as the server address when it
     * differs from `base` (set up at home: only the home address answered); `base` is then
     * kept as the home address.
     */
    suspend fun signIn(base: String, main: String? = null, username: String, password: String) {
        api.baseUrl = base; api.token = null
        val r = api.login(username, password, deviceName)
        adopt(r, base, main ?: base)
    }

    /** Invite sign-up, then the normal sign-in so the token carries this device's name. */
    suspend fun register(base: String, main: String? = null, invite: String, username: String, password: String) {
        ApiClient(base, http = api.http).register(invite, username, password)
        signIn(base, main, username, password)
    }

    /** Demo servers hand out a guest; false on a normal server. */
    suspend fun tryDemo(base: String): Boolean {
        api.baseUrl = base
        val r = attempt { api.demoSignIn(deviceName) } ?: return false
        adopt(r, base, base); return true
    }

    private fun adopt(r: LoginResponse, base: String, main: String) {
        val viaHome = Address.origin(main) != Address.origin(base) || Address.path(main) != Address.path(base)
        val s = Saved(main = main, home = if (viaHome) base else null, homeAuto = !viaHome, token = r.token, user = r.user, demo = r.demo ?: false)
        savedFlow.value = s; userFlow.value = r.user; api.token = r.token; activeBaseFlow.value = base
        persist(s)
        stateFlow.value = if (r.user.mustChangePassword == true) AccountState.PasswordChange else AccountState.SignedIn
        scope.launch { refreshAfterSignIn() }
    }

    suspend fun changePassword(current: String?, new: String) {
        api.changePassword(current, new)
        userFlow.update { it?.copy(mustChangePassword = false) }
        savedFlow.value?.let { s -> s.copy(user = s.user.copy(mustChangePassword = false)).also { savedFlow.value = it; persist(it) } }
        stateFlow.value = AccountState.SignedIn
        refreshAfterSignIn()
    }

    /**
     * Web App.jsx `logOut`: the session goes at once; the logout call runs on its own
     * (offline it would otherwise hold the button for the whole request timeout).
     */
    fun signOut() {
        val ending = ApiClient(api.baseUrl, api.token, api.http)
        clear()
        scope.launch { attempt { ending.logout() } }
    }

    /** The socket said the token is dead (4003). */
    fun signedOutBySession() = clear()

    private fun clear() {
        store.delete(STORE_KEY)
        savedFlow.value = null; userFlow.value = null; prefsFlow.value = emptyMap(); api.token = null
        stateFlow.value = AccountState.SignedOut
    }

    /** On launch and foreground: check the token, refresh addresses + prefs, re-choose the address. */
    suspend fun refreshAfterSignIn() {
        if (stateFlow.value == AccountState.SignedOut) return
        attempt { api.me() }?.let { me ->
            userFlow.value = me
            savedFlow.value?.let { s -> s.copy(user = me).also { savedFlow.value = it; persist(it) } }
        }
        if (stateFlow.value != AccountState.SignedIn) return
        val a = attempt { api.serverAddresses() }
        val s0 = savedFlow.value
        if (a != null && s0 != null) {
            var s = s0.copy(key = a.key)
            val lan = a.lan?.let { Address.normalise(it) }
            if (s.homeAuto && !s.homeOff && lan != null && Address.origin(lan) != Address.origin(s.main)) s = s.copy(home = lan)
            savedFlow.value = s; persist(s)
        }
        attempt { api.prefs() }?.let { prefsFlow.value = it }
        chooseAddress()
    }

    // Home / main

    /** `url` null + `off` false = automatic (the server's LAN address). */
    fun setHome(url: String?, off: Boolean) {
        val s = savedFlow.value ?: return
        val next = s.copy(home = url, homeAuto = url == null && !off, homeOff = off)
        savedFlow.value = next; persist(next)
        scope.launch { chooseAddress() }
    }

    /** API.md §4.4: use home when it proves itself, else main. */
    suspend fun chooseAddress() = choosing.withLock {
        val s = savedFlow.value ?: return@withLock
        if (stateFlow.value != AccountState.SignedIn) return@withLock
        var target = s.main
        val home = s.home
        val key = s.key
        if (!s.homeOff && home != null && key != null) {
            val cellularOnly = network?.path?.value?.cellularOnly == true
            if (!(cellularOnly && Address.isLanOnly(home)) && homeCheck(home, s.user.id, key)) target = home
        }
        if (target != activeBaseFlow.value) {
            activeBaseFlow.value = target; api.baseUrl = target
            onBaseChanged?.invoke(target)
        }
    }

    // Prefs

    fun pref(key: String): JsonElement? = prefsFlow.value[key]

    /** Shallow patch: top-level keys replace; nested objects go whole (API.md §16). Failures dropped. */
    suspend fun patchPrefs(patch: Prefs) {
        attempt { patchPrefsThrowing(patch) }
    }

    /**
     * Shown and relayed at once; the server's error comes back (the local value stays, as on
     * the web, which toasts 'Could not save settings: {error}').
     */
    suspend fun patchPrefsThrowing(patch: Prefs) {
        prefsFlow.update { it + patch }
        onPrefsPatched?.invoke(patch)
        prefsFlow.value = api.patchPrefs(patch)
    }

    /** A patch from another device (socket `prefs`). Keys starting with `_` are signals, not prefs. */
    fun applyRemotePrefs(patch: Prefs) {
        prefsFlow.update { it + patch.filterKeys { k -> !k.startsWith("_") } }
    }

    private fun persist(s: Saved) = store.saveJson(STORE_KEY, Saved.serializer(), s)

    companion object {
        private const val STORE_KEY = "account"
        /** Never resolves (RFC 2606): the client's base before anyone signs in. */
        const val UNSET_BASE = "http://unset.invalid"
        /** UI.md 2.12: 6 s for the main address, 3 s for home. */
        const val MAIN_PROBE_TIMEOUT = 6.0
        const val HOME_PROBE_TIMEOUT = 3.0
        /** Runs on every network change. */
        const val HOME_PROOF_TIMEOUT = 1.5

        /** Every candidate of `typed` probed in parallel; the first in guess order that answers wins. */
        suspend fun findServer(typed: String, timeout: Double, probe: suspend (String, Double) -> Boolean): String? {
            val tries = Address.candidates(typed)
            if (tries.isEmpty()) return null
            val ok = coroutineScope { tries.map { async { probe(it, timeout) } }.awaitAll() }
            return tries.indices.firstOrNull { ok[it] }?.let { tries[it] }
        }
    }
}
