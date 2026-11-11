package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.auth.HomeProof
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeProofTest {
    // Expected value from Node: createHmac('sha256', Buffer.from(key,'hex')).update(nonce).digest('hex')
    private val key = "9c1e" + "ab".repeat(30)
    private val nonce = "00112233445566778899aabbccddeeff"
    private val proof = "45f6ad170a57486a84d2451f10554db3488f0d95776923bcef656ad681bda23b"

    @Test fun matchesServerHmac() {
        assertEquals(proof, HomeProof.expected(key, nonce))
        assertTrue(HomeProof.verify(key, nonce, proof.uppercase()))
        assertFalse(HomeProof.verify(key, nonce, proof.dropLast(1) + "0"))
        assertFalse(HomeProof.verify("zz", nonce, proof))
    }

    @Test fun nonceShape() {
        assertTrue(Regex("^[0-9a-f]{32}$").matches(HomeProof.nonce()))
    }

    /** The check answers its own nonce and never sends a token. */
    @Test fun checkAgainstAServer() = runTest {
        StubServer().use { s ->
            s.server.dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
                override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest): okhttp3.mockwebserver.MockResponse {
                    s.seen += request
                    val n = request.requestUrl!!.queryParameter("n")!!
                    return okhttp3.mockwebserver.MockResponse().setBody("""{"proof":"${HomeProof.expected(key, n)}"}""")
                }
            }
            assertTrue(HomeProof.check(OkHttpClient(), s.base, "u1", key, 2.0))
            assertFalse(HomeProof.check(OkHttpClient(), s.base, "u1", "00".repeat(32), 2.0))
            val r = s.seen.first()
            assertEquals("/api/server/proof", r.requestUrl!!.encodedPath)
            assertEquals("u1", r.requestUrl!!.queryParameter("u"))
            assertEquals(null, r.getHeader("Authorization"))
        }
    }
}
