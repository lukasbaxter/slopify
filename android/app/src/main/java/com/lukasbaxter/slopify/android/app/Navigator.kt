package com.lukasbaxter.slopify.android.app

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.atomic.AtomicLong

enum class Tab { Home, Search, Library }

/**
 * One page on a tab's back stack. `fromHome`: opened from the Home root (zooms out of its tile,
 * a swipe down hides it again). `id` tells two pushes of the same route apart (the shell keys
 * page state by it); it is not part of equality.
 */
data class StackEntry(val route: Route, val fromHome: Boolean = false) {
    val id: Long = ids.incrementAndGet()

    private companion object {
        val ids = AtomicLong()
    }
}

data class NavState(
    val tab: Tab = Tab.Home,
    val stacks: Map<Tab, List<StackEntry>> = Tab.entries.associateWith { emptyList() },
    val nowPlayingOpen: Boolean = false,
    val queueOpen: Boolean = false,
    val drawerOpen: Boolean = false,
    /** Unused by the shell: the device sheet is the mini player's / now playing's own (as on iOS). */
    val deviceSheetOpen: Boolean = false,
    /** Bumped when the lit tab is tapped on its root: the root scrolls to top. */
    val scrollToTop: Map<Tab, Int> = emptyMap(),
) {
    fun stack(t: Tab): List<StackEntry> = stacks[t].orEmpty()
    /** The page showing on the lit tab; null = its root. */
    val top: StackEntry? get() = stack(tab).lastOrNull()
}

/**
 * Tabs, per-tab back stacks and the full-screen layers (ios/docs/DECISIONS.md 7): one stack
 * per tab, now playing and queue above the tabs, the account drawer and the device sheet.
 */
class Navigator {
    private val mutable = MutableStateFlow(NavState())
    val state: StateFlow<NavState> = mutable.asStateFlow()

    fun push(r: Route) = mutable.update { it.withStack(it.tab, it.stack(it.tab) + StackEntry(r)) }

    /** A list opened from the Home root (zooms from its tile on iOS). */
    fun pushFromHome(r: Route) = mutable.update { it.withStack(Tab.Home, it.stack(Tab.Home) + StackEntry(r, fromHome = true)) }

    /** From now playing / queue / drawer: close them, then open the page (DECISIONS fix). */
    fun open(r: Route) {
        mutable.update { it.copy(queueOpen = false, nowPlayingOpen = false, drawerOpen = false) }
        push(r)
    }

    fun select(t: Tab) = mutable.update {
        if (t == it.tab) {
            if (it.stack(t).isNotEmpty()) it.withStack(t, emptyList())
            else it.copy(scrollToTop = it.scrollToTop + (t to ((it.scrollToTop[t] ?: 0) + 1)))
        } else {
            // Home always lands on the Home root, never back where you were (owner, 11-11).
            val s = if (t == Tab.Home) it.withStack(Tab.Home, emptyList()) else it
            s.copy(tab = t)
        }
    }

    /** One page back on the lit tab. False when already at its root. */
    fun pop(): Boolean {
        var popped = false
        mutable.update {
            val s = it.stack(it.tab)
            popped = s.isNotEmpty()
            if (popped) it.withStack(it.tab, s.dropLast(1)) else it
        }
        return popped
    }

    /**
     * The system back gesture: the top layer closes first (queue, now playing, device sheet,
     * drawer), then the lit tab pops. False when there is nothing to close (the app goes back).
     */
    fun back(): Boolean {
        val s = mutable.value
        when {
            s.queueOpen -> setQueueOpen(false)
            s.nowPlayingOpen -> setNowPlayingOpen(false)
            s.deviceSheetOpen -> setDeviceSheetOpen(false)
            s.drawerOpen -> setDrawerOpen(false)
            else -> return pop()
        }
        return true
    }

    fun setNowPlayingOpen(open: Boolean) = mutable.update { it.copy(nowPlayingOpen = open, queueOpen = it.queueOpen && open) }
    fun setQueueOpen(open: Boolean) = mutable.update { it.copy(queueOpen = open) }
    fun setDrawerOpen(open: Boolean) = mutable.update { it.copy(drawerOpen = open) }
    fun setDeviceSheetOpen(open: Boolean) = mutable.update { it.copy(deviceSheetOpen = open) }

    /** Signed out: back to a fresh Home. */
    fun reset() { mutable.value = NavState() }

    private fun NavState.withStack(t: Tab, s: List<StackEntry>) = copy(stacks = stacks + (t to s))
}
