package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.auth.Address
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as web/src/api/address.js and the iOS AddressTests. */
class AddressTest {
    @Test fun guessesSchemeAndTriesTheOther() {
        assertEquals(listOf("https://music.example.com", "http://music.example.com"), Address.candidates("music.example.com"))
        assertEquals(listOf("http://192.168.1.85:8080", "https://192.168.1.85:8080"), Address.candidates("192.168.1.85:8080"))
        assertEquals("http://debster.local", Address.candidates("debster.local").first())
        assertEquals("http://server", Address.candidates("server").first())
    }

    @Test fun typedSchemeIsKeptAndNormalised() {
        assertEquals(listOf("https://music.example.com"), Address.candidates(" HTTPS://Music.Example.com:443/ "))
        assertEquals(listOf("http://h.example.com/sub"), Address.candidates("http://h.example.com:80/sub/"))
        assertEquals("https://h.example.com:8443", Address.normalise("https://h.example.com:8443/?x=1#y"))
    }

    @Test fun rejectsJunk() {
        assertEquals(emptyList<String>(), Address.candidates(""))
        assertEquals(emptyList<String>(), Address.candidates("ftp://x.com"))
        assertEquals(emptyList<String>(), Address.candidates("-bad.com"))
        assertEquals(emptyList<String>(), Address.candidates("bad_host.com"))
    }

    @Test fun lanOnly() {
        assertTrue(Address.isLanOnly("http://192.168.1.85:8080"))
        assertTrue(Address.isLanOnly("http://10.0.0.2"))
        assertTrue(Address.isLanOnly("http://172.20.1.1"))
        assertTrue(Address.isLanOnly("http://debster.local"))
        assertTrue(Address.isLanOnly("http://server"))
        assertFalse(Address.isLanOnly("http://172.32.1.1"))
        assertFalse(Address.isLanOnly("http://100.64.1.2")) // Tailscale
        assertFalse(Address.isLanOnly("https://music.example.com"))
    }

    @Test fun localHosts() {
        assertTrue(Address.isLocal("192.168.1.85"))
        assertFalse(Address.isLocal("1.2.3.999"))
        assertFalse(Address.isLocal("music.example.com"))
    }

    @Test fun origin() {
        assertEquals("https://m.example.com", Address.origin("https://m.example.com/sub"))
        assertEquals("http://192.168.1.2:8080", Address.origin("http://192.168.1.2:8080/x"))
    }
}
