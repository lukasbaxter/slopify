package com.lukasbaxter.slopify.android.core.session

import kotlin.math.ceil

/**
 * Fits a published queue frame under the budget (API.md §20.3: keep it <= ~2.5 MB; the server
 * drops > 3 MB and closes on > 4 MiB). Cuts from the end to 80% until it fits, like the web.
 */
object SocketQueueTrim {
    const val MAX_BYTES: Int = (2.5 * 1024 * 1024).toInt()

    data class Result(val queue: List<QueueItem>, val frame: String)

    /** The items kept and the encoded `{ type: "queue", queue }` frame. */
    fun frame(queue: List<QueueItem>, maxBytes: Int = MAX_BYTES): Result {
        var q = queue
        var text = encode(q)
        while (q.size > 1 && byteSize(text) > maxBytes) {
            // ceil(2 * 0.8) == 2 would never shrink (the web loops forever there): always cut one.
            val keep = minOf(ceil(q.size * 0.8).toInt(), q.size - 1)
            q = q.take(keep)
            text = encode(q)
        }
        return Result(q, text)
    }

    fun encode(q: List<QueueItem>): String = SocketOutgoing.Queue(q).text()

    fun byteSize(s: String): Int = s.toByteArray(Charsets.UTF_8).size
}
