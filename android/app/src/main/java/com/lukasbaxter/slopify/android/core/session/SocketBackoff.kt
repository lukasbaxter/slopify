package com.lukasbaxter.slopify.android.core.session

/**
 * Reconnect delay (API.md §20.2): 1 s, doubling per failure, max 20 s; back to 1 s when the
 * previous connection lived > 5 s. Seconds.
 */
class SocketBackoff {
    var next: Double = INITIAL
        private set

    fun reset() { next = INITIAL }

    /**
     * A connection ended. `lived` is null when it never opened, so a server refusing us right
     * away keeps doubling instead of looping every second.
     */
    fun connectionEnded(lived: Double?) {
        if (lived != null && lived > LIVED_LONG_ENOUGH) reset()
    }

    /** Delay for the reconnect about to be scheduled; doubles the following one. */
    fun take(): Double {
        val d = next
        next = minOf(next * 2, MAXIMUM)
        return d
    }

    companion object {
        const val INITIAL = 1.0
        const val MAXIMUM = 20.0
        const val LIVED_LONG_ENOUGH = 5.0
    }
}

/** What to do when the socket closes (API.md §20.2). */
enum class SocketCloseAction {
    /** Normal path: reconnect with backoff. */
    Reconnect,
    /** 1009: a frame was too big. Shrink the queue, then reconnect. */
    ShrinkAndReconnect,
    /** 4000: another socket with our clientId took over. Do not fight it. */
    Replaced,
    /** 4003: token is dead. Stop and sign out. */
    SignedOut;

    companion object {
        fun of(code: Int?): SocketCloseAction = when (code) {
            4000 -> Replaced
            4003 -> SignedOut
            1009 -> ShrinkAndReconnect
            else -> Reconnect
        }
    }
}
