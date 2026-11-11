package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.core.StubServer
import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class SignInRulesTest {
    @Test fun serverFormMessages() {
        assertEquals("Enter the address of your Slopify server.", SignInRules.serverFormError("  ", ""))
        assertEquals("That server address doesn’t look right. Try something like music.example.com.", SignInRules.serverFormError("-bad.com", ""))
        assertEquals("That home address doesn’t look right. Try something like 192.168.1.10:8080.", SignInRules.serverFormError("music.example.com", "ftp://x"))
        assertNull(SignInRules.serverFormError("music.example.com", ""))
        assertNull(SignInRules.serverFormError("music.example.com", "192.168.1.10:8080"))
    }

    @Test fun noServerMessageUsesHostOnly() {
        assertEquals(
            "No Slopify server answered at music.example.com. Check the address, and that the phone can reach it.",
            SignInRules.noServerMessage("Music.Example.com/sub/"),
        )
        assertEquals("192.168.1.10:8080", SignInRules.hostLabel("http://192.168.1.10:8080/x"))
    }

    @Test fun newPassword() {
        assertEquals("Use 8 characters or more.", SignInRules.newPasswordError("short", "short"))
        assertEquals("The two passwords differ.", SignInRules.newPasswordError("longenough", "longenougH"))
        assertNull(SignInRules.newPasswordError("longenough", "longenough"))
    }

    @Test fun errorText() {
        assertEquals("401: wrong username or password", SignInRules.message(ApiError.Http(401, "wrong username or password")))
        assertEquals("409", SignInRules.message(ApiError.Http(409, "")))
        assertEquals("You’re offline", SignInRules.message(ApiError.Offline()))
        assertEquals("403: password change required", SignInRules.message(ApiError.PasswordChangeRequired()))
    }

    @Test fun inviteLink() {
        val r = SignInRules.invite("https://Music.Example.com:443/?invite=abc123")
        assertEquals("https://music.example.com", r?.base)
        assertEquals("abc123", r?.code)
        assertEquals("http://192.168.1.10:8080", SignInRules.invite("http://192.168.1.10:8080/?invite=x")?.base)
        assertEquals("x y", SignInRules.invite("https://music.example.com/?a=1&invite=x%20y")?.code)
        assertNull(SignInRules.invite("https://music.example.com/?x=1"))
        assertNull(SignInRules.invite("https://music.example.com/?invite="))
        assertNull(SignInRules.invite("ftp://music.example.com/?invite=x"))
    }

    @Test fun appSchemeInviteGuessesTheScheme() {
        assertEquals(SignInInvite("https://music.example.com", "c"), SignInRules.invite("slopify://music.example.com/?invite=c"))
        assertEquals(SignInInvite("http://192.168.1.10:8080", "c"), SignInRules.invite("slopify://192.168.1.10:8080/?invite=c"))
    }

    @Test fun discoveredAddress() {
        assertEquals("http://192.168.1.10:8080", SignInServerBrowser.address(InetAddress.getByName("192.168.1.10"), 8080))
        assertEquals("http://slopify-ab12cd34.local", SignInServerBrowser.address("slopify-ab12cd34.local", 80))
        assertNull(SignInServerBrowser.address(InetAddress.getByName("::1"), 8080))
        assertNull(SignInServerBrowser.address("fe80::1%wlan0", 8080))
    }
}

private class SignInFakeBackend : SignInBackend {
    var answering: Set<String> = emptySet()
    var demo = false
    var signInError: Exception? = null
    val probes = mutableListOf<Pair<String, Double>>()
    val signIns = mutableListOf<List<String?>>()
    val registers = mutableListOf<List<String?>>()
    val passwords = mutableListOf<String>()
    val homes = mutableListOf<String>()

    override suspend fun probe(url: String, timeout: Double): Boolean {
        probes += url to timeout; return url in answering
    }
    override suspend fun tryDemo(base: String): Boolean = demo
    override suspend fun signIn(base: String, main: String?, username: String, password: String) {
        signInError?.let { throw it }
        signIns += listOf(base, main, username, password)
    }
    override suspend fun register(base: String, main: String?, invite: String, username: String, password: String) {
        registers += listOf(base, main, invite, username)
    }
    override suspend fun changePassword(new: String) { passwords += new }
    override fun setHome(url: String) { homes += url }
}

class SignInModelTest {
    private val store = MemoryStore()
    private fun make(b: SignInFakeBackend) = SignInModel(b, store)

    @Test fun startsOnServerScreenWithNothingRemembered() = runTest {
        val m = make(SignInFakeBackend())
        m.start()
        assertEquals(SignInStage.Server, m.state.value.stage)
        assertFalse(m.state.value.canCancelServer)
    }

    @Test fun validationErrorDoesNotProbe() = runTest {
        val b = SignInFakeBackend()
        val m = make(b)
        m.connect()
        assertEquals("Enter the address of your Slopify server.", m.state.value.serverError)
        assertTrue(b.probes.isEmpty())
    }

    @Test fun probesBothSchemesAndFallsBackToHttp() = runTest {
        val b = SignInFakeBackend().apply { answering = setOf("http://music.example.com") }
        val m = make(b)
        m.setMain("music.example.com")
        m.connect()
        assertEquals(setOf("https://music.example.com", "http://music.example.com"), b.probes.map { it.first }.toSet())
        assertTrue(b.probes.all { it.second == Account.MAIN_PROBE_TIMEOUT })
        assertEquals("http://music.example.com", m.state.value.base)
        assertEquals(SignInStage.Login, m.state.value.stage)
        assertFalse(m.state.value.probing)
        assertEquals("http://music.example.com", store.getString(SignInModel.REMEMBER_KEY))
    }

    @Test fun guessWinsWhenBothAnswer() = runTest {
        val b = SignInFakeBackend().apply { answering = setOf("http://music.example.com", "https://music.example.com") }
        val m = make(b)
        m.setMain("music.example.com")
        m.connect()
        assertEquals("https://music.example.com", m.state.value.base)
    }

    @Test fun nothingAnswers() = runTest {
        val m = make(SignInFakeBackend())
        m.setMain("music.example.com")
        m.connect()
        assertEquals(SignInStage.Server, m.state.value.stage)
        assertNull(m.state.value.base)
        assertFalse(m.state.value.probing)
        assertEquals(
            "No Slopify server answered at music.example.com. Check the address, and that the phone can reach it.",
            m.state.value.serverError,
        )
    }

    @Test fun homeAloneIsEnoughAndHomeIsSetAfterSignIn() = runTest {
        val b = SignInFakeBackend().apply { answering = setOf("http://192.168.1.10:8080", "https://music.example.com") }
        val m = make(b)
        m.setMain("music.example.com"); m.setHome("192.168.1.10:8080")
        m.connect()
        assertTrue(b.probes.any { it.first == "http://192.168.1.10:8080" && it.second == Account.HOME_PROBE_TIMEOUT })
        assertEquals("https://music.example.com", m.state.value.base)
        assertEquals("http://192.168.1.10:8080", m.state.value.pendingHome)
        m.setUsername(" lukas "); m.setPassword("pw")
        m.logIn()
        assertEquals(listOf("https://music.example.com", null, "lukas", "pw"), b.signIns.first())
        assertEquals(listOf("http://192.168.1.10:8080"), b.homes)
        assertNull(m.state.value.pendingHome)
        assertEquals("", m.state.value.password)

        // Only home answers: it becomes the base, the typed main is kept as the server address.
        val b2 = SignInFakeBackend().apply { answering = setOf("http://192.168.1.10:8080") }
        val m2 = SignInModel(b2, MemoryStore())
        m2.setMain("music.example.com"); m2.setHome("192.168.1.10:8080")
        m2.connect()
        assertEquals("http://192.168.1.10:8080", m2.state.value.base)
        assertNull(m2.state.value.pendingHome)
        assertEquals("https://music.example.com", m2.state.value.awayMain)
        assertEquals("https://music.example.com", m2.state.value.main)
        m2.setUsername("lukas"); m2.setPassword("pw")
        m2.logIn()
        assertEquals(listOf("http://192.168.1.10:8080", "https://music.example.com", "lukas", "pw"), b2.signIns.first())
        assertNull(m2.state.value.awayMain)
    }

    @Test fun demoServerNeverShowsTheForm() = runTest {
        val b = SignInFakeBackend().apply { answering = setOf("https://music.example.com"); demo = true }
        val m = make(b)
        m.setMain("music.example.com")
        m.connect()
        assertEquals(SignInStage.Starting, m.state.value.stage)
        assertTrue(b.signIns.isEmpty())
    }

    @Test fun rememberedServerSkipsServerScreen() = runTest {
        store.putString(SignInModel.REMEMBER_KEY, "https://music.example.com")
        val m = make(SignInFakeBackend())
        assertEquals("https://music.example.com", m.state.value.main)
        assertEquals(SignInStage.Starting, m.state.value.stage)
        m.start()
        assertEquals(SignInStage.Login, m.state.value.stage)
        assertTrue(m.state.value.canCancelServer)
        m.editServer()
        assertEquals(SignInStage.Server, m.state.value.stage)
        m.cancelServerEdit()
        assertEquals(SignInStage.Login, m.state.value.stage)
    }

    @Test fun loginNeedsAUsernameAndShowsServerError() = runTest {
        store.putString(SignInModel.REMEMBER_KEY, "https://music.example.com")
        val b = SignInFakeBackend().apply { signInError = ApiError.Http(401, "wrong username or password") }
        val m = make(b)
        m.start()
        assertFalse(m.state.value.canLogIn)
        m.logIn()
        assertNull(m.state.value.loginError)
        m.setUsername("lukas"); m.setPassword("nope")
        assertTrue(m.state.value.canLogIn)
        m.logIn()
        assertEquals("401: wrong username or password", m.state.value.loginError)
        assertFalse(m.state.value.busy)
    }

    @Test fun inviteRegistersAndSkipsDemo() = runTest {
        val b = SignInFakeBackend().apply { demo = true }
        val m = make(b)
        assertTrue(m.acceptInvite("https://music.example.com/?invite=code1"))
        m.start()
        assertEquals(SignInStage.Login, m.state.value.stage)
        assertEquals("code1", m.state.value.invite)
        assertEquals("https://music.example.com", store.getString(SignInModel.REMEMBER_KEY))
        m.setUsername("newbie"); m.setPassword("longenough")
        m.logIn()
        assertEquals("https://music.example.com", b.registers.first()[0])
        assertEquals("code1", b.registers.first()[2])
        assertTrue(b.signIns.isEmpty())
        assertNull(m.state.value.invite)
    }

    @Test fun notAnInviteIsIgnored() {
        val m = make(SignInFakeBackend())
        assertFalse(m.acceptInvite("https://music.example.com/album?id=1"))
        assertNull(m.state.value.invite)
        assertEquals(SignInStage.Server, m.state.value.stage)
    }

    @Test fun changePasswordValidatesFirst() = runTest {
        val b = SignInFakeBackend()
        val m = make(b)
        assertFalse(m.state.value.canSavePassword)
        m.setNewPassword("short"); m.setAgain("short")
        m.savePassword()
        assertEquals("Use 8 characters or more.", m.state.value.passwordError)
        m.setNewPassword("longenough"); m.setAgain("different1")
        m.savePassword()
        assertEquals("The two passwords differ.", m.state.value.passwordError)
        assertTrue(b.passwords.isEmpty())
        m.setAgain("longenough")
        m.savePassword()
        assertNull(m.state.value.passwordError)
        assertEquals(listOf("longenough"), b.passwords)
        assertEquals("", m.state.value.newPassword)
    }

    @Test fun useDiscoveredFillsField() {
        val m = make(SignInFakeBackend())
        m.use("http://192.168.1.10:8080")
        assertEquals("http://192.168.1.10:8080", m.state.value.main)
    }
}

/** The real backend against a stub server: probe, wrong password text, sign in. */
class SignInAccountBackendTest {
    @Test fun probeAndSignInThroughAccount() = runTest {
        StubServer().use { stub ->
            val account = Account(MemoryStore(), Connectivity(backgroundScope), null, backgroundScope, "Pixel 9")
            val backend = SignInAccountBackend(account)
            stub.answers["/api/healthz"] = 200 to """{"ok":true}"""
            stub.answers["/api/auth/demo"] = 404 to """{"error":"not a demo server"}"""
            stub.answers["/api/auth/login"] = 401 to """{"error":"wrong username or password"}"""
            val m = SignInModel(backend, MemoryStore())
            m.setMain(stub.base)
            m.connect()
            assertEquals(stub.base, m.state.value.base)
            assertEquals(SignInStage.Login, m.state.value.stage)
            m.setUsername("lukas"); m.setPassword("nope")
            m.logIn()
            assertEquals("401: wrong username or password", m.state.value.loginError)
            assertEquals(AccountState.SignedOut, account.state.value)

            synchronized(stub.answers) {
                stub.answers["/api/auth/login"] = 200 to """{"token":"T","user":{"id":"u1","name":"lukas","role":"user"}}"""
            }
            m.logIn()
            assertNull(m.state.value.loginError)
            assertEquals(AccountState.SignedIn, account.state.value)
            assertEquals("lukas", account.user.value?.name)
        }
    }
}
