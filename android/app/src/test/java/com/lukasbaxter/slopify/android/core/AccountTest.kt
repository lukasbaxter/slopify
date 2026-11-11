@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.me
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.core.auth.FakeNetworkMonitor
import com.lukasbaxter.slopify.android.core.auth.NetworkPath
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import com.lukasbaxter.slopify.android.core.stores.Connectivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Waits (real time, the test scheduler keeps running) until `cond` holds. */
suspend fun TestScope.eventually(what: String = "condition", cond: () -> Boolean) {
    repeat(600) {
        if (cond()) return
        withContext(Dispatchers.IO) { Thread.sleep(5) }
        testScheduler.runCurrent()
    }
    fail("timed out waiting for $what")
}

class AccountTest {
    private val user = """{"id":"u1","name":"Lukas","role":"admin"}"""

    private fun StubServer.signInAnswers(lan: String?) {
        answers["/api/auth/login"] = 200 to """{"token":"tok","user":$user}"""
        answers["/api/auth/me"] = 200 to user
        answers["/api/server/addresses"] = 200 to """{"key":"abcd","lan":${lan?.let { "\"$it/\"" } ?: "null"},"public":[]}"""
        answers["/api/prefs"] = 200 to """{"normalize":true}"""
    }

    private fun account(scope: CoroutineScope, store: MemoryStore, net: FakeNetworkMonitor, check: (String) -> Boolean = { true }, calls: MutableList<String>? = null) =
        Account(store, Connectivity(scope), net, scope, "Pixel 9", homeCheck = { home, _, _ -> calls?.add(home); check(home) })

    @Test fun signInPicksUpHomeAndMovesThere() = runTest {
        StubServer().use { main -> StubServer().use { home ->
            main.signInAnswers(home.base)
            val store = MemoryStore()
            val net = FakeNetworkMonitor()
            val a = account(backgroundScope, store, net)
            val moved = mutableListOf<String>()
            a.onBaseChanged = { moved += it }
            assertEquals(AccountState.SignedOut, a.state.value)
            a.signIn(main.base, username = "lukas", password = "pw")
            assertEquals(AccountState.SignedIn, a.state.value)
            assertEquals("tok", a.api.token)
            eventually("home chosen") { a.activeBase.value == home.base }
            assertEquals(main.base, a.saved.value?.main)
            assertEquals(home.base, a.saved.value?.home)
            assertEquals("abcd", a.saved.value?.key)
            assertTrue(a.onHome)
            assertEquals(listOf(home.base), moved)
            assertEquals(JsonPrimitive(true), a.prefs.value["normalize"])
            val login = main.seen.first { it.requestUrl!!.encodedPath == "/api/auth/login" }.body.readUtf8()
            assertTrue(login.contains("\"device\":\"Pixel 9\"") && login.contains("\"kind\":\"phone\""))

            // Mobile data only: a LAN-only home is skipped, main is used.
            net.path.value = NetworkPath(satisfied = true, cellular = true, networkId = 2)
            eventually("back on main") { a.activeBase.value == main.base }
            assertFalse(a.onHome)

            // A fresh process restores the account from secure storage.
            val again = account(backgroundScope, store, FakeNetworkMonitor(null))
            assertEquals(AccountState.SignedIn, again.state.value)
            assertEquals(main.base, again.api.baseUrl)
            assertEquals("tok", again.api.token)
        } }
    }

    @Test fun homeThatFailsItsProofIsNotUsed() = runTest {
        StubServer().use { main -> StubServer().use { home ->
            main.signInAnswers(home.base)
            val calls = mutableListOf<String>()
            val a = account(backgroundScope, MemoryStore(), FakeNetworkMonitor(), check = { false }, calls = calls)
            a.signIn(main.base, username = "lukas", password = "pw")
            eventually("proof asked") { calls.isNotEmpty() && a.saved.value?.home != null }
            assertEquals(main.base, a.activeBase.value)
            // Off: never even asked.
            calls.clear()
            a.setHome(null, off = true)
            eventually("off saved") { a.saved.value?.homeOff == true }
            a.chooseAddress()
            assertTrue(calls.isEmpty())
            assertNull(a.saved.value?.home)
        } }
    }

    @Test fun setUpAtHomeKeepsMainAsTheServerAddress() = runTest {
        StubServer().use { main -> StubServer().use { home ->
            home.signInAnswers(null)
            val a = account(backgroundScope, MemoryStore(), FakeNetworkMonitor())
            a.signIn(home.base, main = main.base, username = "lukas", password = "pw")
            assertEquals(main.base, a.saved.value?.main)
            assertEquals(home.base, a.saved.value?.home)
            assertEquals(false, a.saved.value?.homeAuto)
            assertEquals(home.base, a.activeBase.value)
        } }
    }

    @Test fun unauthorizedSignsOutAndClearsStorage() = runTest {
        StubServer().use { s ->
            s.signInAnswers(null)
            val store = MemoryStore()
            val a = account(backgroundScope, store, FakeNetworkMonitor())
            a.signIn(s.base, username = "lukas", password = "pw")
            assertNotNull(store.load("account"))
            s.answers["/api/auth/me"] = 401 to """{"error":"unauthorized"}"""
            runCatching { a.api.me() }
            assertEquals(AccountState.SignedOut, a.state.value)
            assertNull(store.load("account"))
            assertNull(a.api.token)
            assertTrue(a.prefs.value.isEmpty())
        }
    }

    @Test fun passwordChangeFlow() = runTest {
        StubServer().use { s ->
            s.signInAnswers(null)
            s.answers["/api/auth/login"] = 200 to """{"token":"tok","user":{"id":"u1","name":"Lukas","role":"user","mustChangePassword":true}}"""
            s.answers["/api/auth/password"] = 200 to """{"ok":true}"""
            val a = account(backgroundScope, MemoryStore(), FakeNetworkMonitor())
            a.signIn(s.base, username = "lukas", password = "pw")
            assertEquals(AccountState.PasswordChange, a.state.value)
            a.changePassword("pw", "new")
            assertEquals(AccountState.SignedIn, a.state.value)
            assertTrue(a.saved.value?.user?.mustChangePassword != true)
        }
    }

    @Test fun signOutIsImmediateAndLogsOutInTheBackground() = runTest {
        StubServer().use { s ->
            s.signInAnswers(null)
            val a = account(backgroundScope, MemoryStore(), FakeNetworkMonitor())
            a.signIn(s.base, username = "lukas", password = "pw")
            a.signOut()
            assertEquals(AccountState.SignedOut, a.state.value)
            eventually("logout sent") { s.seen.any { it.requestUrl!!.encodedPath == "/api/auth/logout" } }
            assertEquals("Bearer tok", s.seen.last { it.requestUrl!!.encodedPath == "/api/auth/logout" }.getHeader("Authorization"))
        }
    }

    @Test fun prefsPatchAndRemote() = runTest {
        StubServer().use { s ->
            s.signInAnswers(null)
            val a = account(backgroundScope, MemoryStore(), FakeNetworkMonitor())
            a.signIn(s.base, username = "lukas", password = "pw")
            val relayed = mutableListOf<Map<String, *>>()
            a.onPrefsPatched = { relayed += it }
            s.answers["/api/prefs"] = 200 to """{"normalize":true,"gapless":false}"""
            a.patchPrefsThrowing(mapOf("gapless" to JsonPrimitive(false)))
            assertEquals(1, relayed.size)
            assertEquals(JsonPrimitive(false), a.pref("gapless"))
            a.applyRemotePrefs(mapOf("crossfade" to JsonPrimitive(4), "_libraryLayout" to JsonPrimitive("r1")))
            assertEquals(JsonPrimitive(4), a.pref("crossfade"))
            assertNull(a.pref("_libraryLayout"))
            s.answers["/api/prefs"] = 500 to """{"error":"nope"}"""
            a.patchPrefs(mapOf("x" to JsonPrimitive(1))) // swallowed, local value stays
            assertEquals(JsonPrimitive(1), a.pref("x"))
        }
    }
}
