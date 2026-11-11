package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.api.ApiClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.CopyOnWriteArrayList

/** Records every request and answers from a per-path-suffix table (JSON shapes from API.md). */
class StubServer : AutoCloseable {
    val server = MockWebServer()
    val seen = CopyOnWriteArrayList<RecordedRequest>()
    /** Path suffix -> (status, body). The first match in insertion order wins. */
    val answers = LinkedHashMap<String, Pair<Int, String>>()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                seen += request
                val path = request.requestUrl?.encodedPath ?: ""
                val (status, body) = synchronized(answers) { answers.entries.firstOrNull { path.endsWith(it.key) }?.value } ?: (200 to "{}")
                return MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
    }

    val base: String get() = server.url("/").toString().trimEnd('/')

    fun client(token: String? = "T") = ApiClient(base, token)

    override fun close() = server.shutdown()
}
