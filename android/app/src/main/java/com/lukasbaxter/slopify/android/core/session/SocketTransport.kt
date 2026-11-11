package com.lukasbaxter.slopify.android.core.session

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

/** What a connection reports, in order. */
sealed interface SocketEvent {
    data object Open : SocketEvent
    data class Message(val message: SocketMessage) : SocketEvent
    /** `code` null = network failure without a close frame. */
    data class Closed(val code: Int?) : SocketEvent
}

/** What `SessionClient` needs from a connection. Tests swap in a fake; no real network. */
interface SocketTransport {
    val events: Flow<SocketEvent>
    fun start()
    /** Fire and forget; order is kept. */
    fun send(text: String)
    /** Our own close: no `Closed` event follows. */
    fun close()
}

/**
 * One OkHttp WebSocket. Frames are parsed on OkHttp's reader thread; the session consumes
 * `events` in order on its own scope.
 */
class OkHttpSocket(private val client: OkHttpClient, private val url: String) : SocketTransport {
    private val channel = Channel<SocketEvent>(Channel.UNLIMITED)
    private val finished = AtomicBoolean(false)
    private var ws: WebSocket? = null

    override val events: Flow<SocketEvent> = channel.receiveAsFlow()

    override fun start() {
        ws = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!finished.get()) channel.trySend(SocketEvent.Open)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (finished.get()) return
                SocketMessage.parse(text)?.let { channel.trySend(SocketEvent.Message(it)) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                finish(code)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish(code)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = finish(null)
        })
    }

    override fun send(text: String) {
        ws?.send(text)
    }

    override fun close() {
        if (finished.getAndSet(true)) return
        channel.close()
        ws?.close(1000, null)
    }

    private fun finish(code: Int?) {
        if (finished.getAndSet(true)) return
        channel.trySend(SocketEvent.Closed(code))
        channel.close()
    }
}
