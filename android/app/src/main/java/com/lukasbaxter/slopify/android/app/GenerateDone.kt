package com.lukasbaxter.slopify.android.app

import com.lukasbaxter.slopify.android.core.model.GenerateResult
import com.lukasbaxter.slopify.android.design.L

/** What happens when a "Generated playlist (AI)" job ends, in the web's words (App.jsx:1785-1805). */
object GenerateDone {
    /** `open`: show the playlist's page. `toast`: what to say, if anything. */
    data class Plan(val open: Boolean, val toast: String?)

    /** "N more songs are downloading and will be added.", or null when none are. */
    fun moreText(requested: Int): String? = when {
        requested <= 0 -> null
        requested == 1 -> L("1 more song is downloading and will be added.")
        else -> L("{n} more songs are downloading and will be added.", "n" to requested)
    }

    /**
     * `hidden`: the dialog was closed (Hide) before the job ended. `onScreen`: that playlist's
     * page is the one showing.
     * - Regenerated: a toast; the page is opened when the dialog was still open and it is not
     *   already showing (an open page reloads by itself).
     * - New, after Hide: "{name} is ready in Your Library."
     * - New, dialog open: the playlist opens; when more songs are still downloading the web says
     *   so instead of opening it.
     */
    fun plan(r: GenerateResult, hidden: Boolean, onScreen: Boolean): Plan {
        val more = moreText(r.requested)
        return when {
            r.regenerated -> Plan(
                open = !hidden && !onScreen,
                toast = if (more != null) L("{name} regenerated. {more}", "name" to r.name, "more" to more) else L("{name} regenerated", "name" to r.name),
            )
            hidden -> Plan(
                open = false,
                toast = if (more != null) L("{name} is ready in Your Library. {more}", "name" to r.name, "more" to more) else L("{name} is ready in Your Library.", "name" to r.name),
            )
            more != null -> Plan(open = false, toast = more)
            else -> Plan(open = true, toast = null)
        }
    }

    fun failedText(error: String): String = L("Could not generate the playlist: {error}", "error" to error)
}
