package com.lukasbaxter.slopify.android.core.session

/** Server clock estimate and playhead extrapolation (API.md §20.9). All times epoch ms. */
class SocketClock {
    /** server = local + offset. null until the first hello-ok / pong. */
    var offset: Double? = null
        private set
    var bestRtt: Double = Double.POSITIVE_INFINITY
        private set

    /** The shortest round trips win, so one slow sample does not drag the offset. */
    fun pong(now: Double, t: Double, localNow: Double) {
        val rtt = localNow - t
        if (rtt < 0 || rtt > bestRtt + 15) return
        bestRtt = minOf(bestRtt, rtt)
        offset = now - (t + rtt / 2)
    }

    /** A first rough offset from hello-ok, only when none is known yet. */
    fun helloOk(now: Double, localNow: Double, openedAt: Double) {
        if (offset != null) return
        val rtt = maxOf(0.0, localNow - openedAt)
        bestRtt = rtt
        offset = now - (localNow - rtt / 2)
    }

    fun serverNow(localNow: Double): Double = localNow + (offset ?: 0.0)

    /**
     * Seconds. `rxAt` = our local receipt time of the report, the fallback when the server
     * stamp cannot be used. The sender's `at` is never used: other devices' clocks drift.
     */
    fun playhead(np: NowPlaying, rxAt: Double?, localNow: Double): Double {
        if (!np.playing || np.held == true) return np.position
        val serverAt = np.serverAt
        val since = when {
            serverAt != null && offset != null -> serverNow(localNow) - serverAt
            rxAt != null -> localNow - rxAt
            else -> 0.0
        }
        return np.position + maxOf(0.0, since) / 1000
    }

    companion object {
        fun localNow(): Double = System.currentTimeMillis().toDouble()
    }
}
