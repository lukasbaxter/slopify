package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.ApiClient
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import okhttp3.ResponseBody.Companion.asResponseBody
import okio.Buffer
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 11-12: lists never loaded on Android (NetworkOnMainThreadException). The call was sent on
 * OkHttp's thread but its body was read after resuming on the caller's thread, which is Main.
 * Every body read must happen off the calling thread.
 */
class BodyOffCallerThreadTest {
    @Test
    fun aResponseBodyIsNeverReadOnTheCallingThread() {
        StubServer().use { s ->
            s.answers["/api/playlists"] = 200 to """{"items":[${(1..2000).joinToString(",") { """{"id":"p$it","name":"Playlist $it"}""" }}]}"""
            val readers = CopyOnWriteArrayList<Thread>()
            val http = ApiClient.defaultHttp().newBuilder().addNetworkInterceptor { chain ->
                val r = chain.proceed(chain.request())
                val body = r.body ?: return@addNetworkInterceptor r
                val watched = object : ForwardingSource(body.source()) {
                    override fun read(sink: Buffer, byteCount: Long): Long { readers += Thread.currentThread(); return super.read(sink, byteCount) }
                }.buffer()
                r.newBuilder().body(watched.asResponseBody(body.contentType(), body.contentLength())).build()
            }.build()
            val api = ApiClient(s.base, "T", http)
            val caller = Thread.currentThread()
            runBlocking { api.get<JsonElement>("api/playlists") }
            assertTrue("the body was read", readers.isNotEmpty())
            assertTrue("read on the calling thread: ${readers.map { it.name }.distinct()}", readers.none { it === caller })
        }
    }
}
