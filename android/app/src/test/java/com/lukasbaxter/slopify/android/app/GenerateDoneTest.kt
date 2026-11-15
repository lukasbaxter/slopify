package com.lukasbaxter.slopify.android.app

import com.lukasbaxter.slopify.android.core.model.GenerateResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What a finished Generate job does (App.jsx:1785-1805). English: no locale is loaded. */
class GenerateDoneTest {
    private fun result(regenerated: Boolean = false, requested: Int = 0) = GenerateResult("pl_9", "Rainy day", regenerated, 25, requested)

    @Test fun moreText() {
        assertNull(GenerateDone.moreText(0))
        assertEquals("1 more song is downloading and will be added.", GenerateDone.moreText(1))
        assertEquals("3 more songs are downloading and will be added.", GenerateDone.moreText(3))
    }

    @Test fun newPlaylistOpensWhileTheDialogIsStillOpen() {
        assertEquals(GenerateDone.Plan(open = true, toast = null), GenerateDone.plan(result(), hidden = false, onScreen = false))
    }

    @Test fun newPlaylistAfterHideIsAnnounced() {
        assertEquals(
            GenerateDone.Plan(open = false, toast = "Rainy day is ready in Your Library."),
            GenerateDone.plan(result(), hidden = true, onScreen = false),
        )
        assertEquals(
            GenerateDone.Plan(open = false, toast = "Rainy day is ready in Your Library. 2 more songs are downloading and will be added."),
            GenerateDone.plan(result(requested = 2), hidden = true, onScreen = false),
        )
    }

    @Test fun newPlaylistWithSongsStillDownloadingSaysSo() {
        // The web toasts the "more" line here instead of opening the page.
        assertEquals(
            GenerateDone.Plan(open = false, toast = "1 more song is downloading and will be added."),
            GenerateDone.plan(result(requested = 1), hidden = false, onScreen = false),
        )
    }

    @Test fun regeneratedToastsAndOpensUnlessHiddenOrAlreadyShowing() {
        assertEquals(GenerateDone.Plan(open = true, toast = "Rainy day regenerated"), GenerateDone.plan(result(true), hidden = false, onScreen = false))
        // Its page is showing: it reloads in place, nothing is pushed.
        assertEquals(GenerateDone.Plan(open = false, toast = "Rainy day regenerated"), GenerateDone.plan(result(true), hidden = false, onScreen = true))
        assertEquals(GenerateDone.Plan(open = false, toast = "Rainy day regenerated"), GenerateDone.plan(result(true), hidden = true, onScreen = true))
        assertEquals(GenerateDone.Plan(open = false, toast = "Rainy day regenerated"), GenerateDone.plan(result(true), hidden = true, onScreen = false))
        assertEquals(
            GenerateDone.Plan(open = false, toast = "Rainy day regenerated. 3 more songs are downloading and will be added."),
            GenerateDone.plan(result(true, requested = 3), hidden = true, onScreen = false),
        )
    }

    @Test fun failureAfterHide() {
        assertEquals("Could not generate the playlist: the brain is busy", GenerateDone.failedText("the brain is busy"))
    }
}
