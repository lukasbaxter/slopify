package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.Address
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.coroutines.cancellation.CancellationException

/** What the sign-in flow needs from the outside world. `Account` in the app, fakes in tests. */
internal interface SignInBackend {
    /** `GET {url}/api/healthz` answers `{ok: true}` within `timeout` seconds. */
    suspend fun probe(url: String, timeout: Double): Boolean
    /** A demo server signs a guest straight in; false on a normal server. */
    suspend fun tryDemo(base: String): Boolean
    /** Through `base`; `main` (when set) is kept as the server address (`base` is then home). */
    suspend fun signIn(base: String, main: String?, username: String, password: String)
    suspend fun register(base: String, main: String?, invite: String, username: String, password: String)
    suspend fun changePassword(new: String)
    /** A home address typed before sign-in, applied once signed in. */
    fun setHome(url: String)
}

internal enum class SignInStage { Server, Starting, Login }

internal data class SignInUiState(
    val stage: SignInStage = SignInStage.Server,
    // Server address screen
    val main: String = "",
    val home: String = "",
    val serverError: String? = null,
    val probing: Boolean = false,
    /** The answering server; set once the server screen succeeds (or from memory / an invite). */
    val base: String? = null,
    /** Home address typed on the server screen, set on the account after sign-in. */
    val pendingHome: String? = null,
    /**
     * Set up at home: only the home address answered, so `base` is home and this is the typed
     * main address, kept as the server address at sign-in.
     */
    val awayMain: String? = null,
    // Sign-in form
    val username: String = "",
    val password: String = "",
    val loginError: String? = null,
    val busy: Boolean = false,
    /** Invite code from an invite link: the form becomes sign-up. */
    val invite: String? = null,
    // First password
    val newPassword: String = "",
    val again: String = "",
    val passwordError: String? = null,
    val saving: Boolean = false,
) {
    /** Cancel shows on the server screen only when a server is already known (editing). */
    val canCancelServer: Boolean get() = base != null
    val canLogIn: Boolean get() = !busy && username.isNotEmpty()
    val canSavePassword: Boolean get() = !saving && newPassword.isNotEmpty()
}

/**
 * State of the sign-in flow (UI.md 2.12): server address, demo check, sign-in / sign-up form,
 * first password. The forced password screen itself follows `Account.state`.
 * Call from the main thread.
 */
internal class SignInModel(private val backend: SignInBackend, private val store: KeyValueStore) {
    private val flow: MutableStateFlow<SignInUiState>
    val state: StateFlow<SignInUiState>
    private var started = false

    init {
        val remembered = store.getString(REMEMBER_KEY)?.let { Address.normalise(it) }
        // A remembered server starts on "Starting" so the server screen never flashes.
        flow = MutableStateFlow(
            SignInUiState(
                stage = if (remembered != null) SignInStage.Starting else SignInStage.Server,
                base = remembered,
                main = remembered.orEmpty(),
            ),
        )
        state = flow.asStateFlow()
    }

    private inline fun set(f: SignInUiState.() -> SignInUiState) = flow.update(f)

    fun setMain(v: String) = set { copy(main = v) }
    fun setHome(v: String) = set { copy(home = v) }
    fun setUsername(v: String) = set { copy(username = v) }
    fun setPassword(v: String) = set { copy(password = v) }
    fun setNewPassword(v: String) = set { copy(newPassword = v) }
    fun setAgain(v: String) = set { copy(again = v) }

    /** First appearance: a remembered server goes straight to the demo check and the form. */
    suspend fun start() {
        if (started) return
        started = true
        val s = flow.value
        if (s.base == null || s.invite != null || s.stage != SignInStage.Starting) return
        enter()
    }

    // Server address

    suspend fun connect() {
        val s = flow.value
        if (s.probing) return
        SignInRules.serverFormError(s.main, s.home)?.let { e -> set { copy(serverError = e) }; return }
        set { copy(probing = true, serverError = null) }
        val typedHome = s.home.isNotBlank()
        val (mFound, hFound) = try {
            coroutineScope {
                val m = async { find(s.main, Account.MAIN_PROBE_TIMEOUT) }
                val h = async { if (typedHome) find(s.home, Account.HOME_PROBE_TIMEOUT) else null }
                m.await() to h.await()
            }
        } finally {
            set { copy(probing = false) }
        }
        // Either answering is enough: set up at home, main may only answer from outside.
        val found = mFound ?: hFound ?: run {
            set { copy(serverError = SignInRules.noServerMessage(s.main)) }
            return
        }
        val pendingHome = hFound?.takeIf { it != found }
        val awayMain = if (mFound == null) Address.candidates(s.main).firstOrNull()?.takeIf { it != found } else null
        store.putString(REMEMBER_KEY, found)
        set { copy(base = found, pendingHome = pendingHome, awayMain = awayMain, main = awayMain ?: found) }
        enter()
    }

    fun editServer() {
        val s = flow.value
        if (s.busy) return
        set { copy(main = s.base ?: main, serverError = null, stage = SignInStage.Server) }
    }

    fun cancelServerEdit() {
        val s = flow.value
        if (s.base == null || s.probing) return
        set { copy(serverError = null, stage = SignInStage.Login) }
    }

    /** A server found on the network: its address goes into the field (like "Use it"). */
    fun use(address: String) = set { copy(main = address, serverError = null) }

    private suspend fun find(typed: String, timeout: Double): String? =
        Account.findServer(typed, timeout) { url, t -> backend.probe(url, t) }

    /** Demo check, then the form (web Login: `tryingDemo`). Invite links skip the demo check. */
    private suspend fun enter() {
        val s = flow.value
        val base = s.base ?: return
        if (s.invite == null) {
            set { copy(stage = SignInStage.Starting) }
            if (backend.tryDemo(base)) return
        }
        set { copy(stage = SignInStage.Login) }
    }

    // Invite

    /** True when `url` was an invite link (the caller then consumes it). */
    fun acceptInvite(url: String): Boolean {
        val link = SignInRules.invite(url) ?: return false
        store.putString(REMEMBER_KEY, link.base)
        set {
            copy(invite = link.code, base = link.base, main = link.base, awayMain = null, loginError = null, stage = SignInStage.Login)
        }
        return true
    }

    // Sign in

    suspend fun logIn() {
        val s = flow.value
        if (!s.canLogIn) return
        val base = s.base ?: return
        set { copy(busy = true, loginError = null) }
        val name = s.username.trim()
        try {
            val invite = s.invite
            if (invite != null) {
                backend.register(base, s.awayMain, invite, name, s.password)
                set { copy(invite = null) }
            } else {
                backend.signIn(base, s.awayMain, name, s.password)
            }
            set { copy(awayMain = null, password = "") }
            s.pendingHome?.let { backend.setHome(it); set { copy(pendingHome = null) } }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            set { copy(loginError = SignInRules.message(e)) }
        } finally {
            set { copy(busy = false) }
        }
    }

    // First password

    suspend fun savePassword() {
        val s = flow.value
        if (!s.canSavePassword) return
        SignInRules.newPasswordError(s.newPassword, s.again)?.let { e -> set { copy(passwordError = e) }; return }
        set { copy(saving = true, passwordError = null) }
        try {
            backend.changePassword(s.newPassword)
            set { copy(newPassword = "", again = "") }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            set { copy(passwordError = SignInRules.message(e)) }
        } finally {
            set { copy(saving = false) }
        }
    }

    companion object {
        const val REMEMBER_KEY = "slopify.signin.server"
    }
}
