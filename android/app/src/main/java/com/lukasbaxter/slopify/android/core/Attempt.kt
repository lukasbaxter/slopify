package com.lukasbaxter.slopify.android.core

import kotlin.coroutines.cancellation.CancellationException

/**
 * `try?` for suspend code: the value, or null on any failure. Cancellation is never
 * swallowed (runCatching would), so a cancelled scope still stops.
 */
inline fun <T> attempt(block: () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}
