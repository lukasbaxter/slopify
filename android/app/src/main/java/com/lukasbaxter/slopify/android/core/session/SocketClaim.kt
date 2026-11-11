package com.lukasbaxter.slopify.android.core.session

/** Claim bookkeeping for re-assertion (API.md §20.7). Times epoch ms. */
class SocketClaim {
    var claimed: Boolean = false
        private set
    var claimedAt: Double = 0.0
        private set

    /** Local play press. */
    fun claim(at: Double) { claimed = true; claimedAt = at }

    /** `command.yield`: someone else took over; never reassert this one. */
    fun yielded() { claimed = false }

    /** `ago` for a `{ claim, reassert }` after hello-ok, or null when nothing is held. */
    fun reassertAgo(now: Double): Double? {
        if (!claimed) return null
        return (now - claimedAt).coerceIn(0.0, MAX_AGO)
    }

    companion object {
        const val MAX_AGO: Double = 7.0 * 24 * 3600 * 1000
    }
}
