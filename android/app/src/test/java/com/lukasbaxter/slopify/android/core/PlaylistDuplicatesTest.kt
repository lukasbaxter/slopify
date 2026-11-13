package com.lukasbaxter.slopify.android.core

import com.lukasbaxter.slopify.android.core.stores.LibraryEvent
import com.lukasbaxter.slopify.android.core.stores.PlaylistDuplicates
import com.lukasbaxter.slopify.android.core.stores.PlaylistDuplicates.Answer
import com.lukasbaxter.slopify.android.design.designTrack
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaylistDuplicatesTest {
    private val tracks = listOf("a", "b", "a", "c", "b").map { designTrack(it) }

    @Test fun aDuplicateIsInThePlaylistOrEarlierInTheBatch() {
        assertEquals(listOf(false, false, true, false, true), PlaylistDuplicates.mark(listOf("a", "b", "a", "c", "b"), emptyList()))
        assertEquals(listOf(true, false, true, true, true), PlaylistDuplicates.mark(listOf("a", "b", "a", "c", "b"), listOf("a", "c")))
        assertEquals(emptyList<Boolean>(), PlaylistDuplicates.mark(emptyList(), listOf("a")))
    }

    @Test fun asksEachDuplicateInTurnWithHowManyAreLeft() = runBlocking {
        val dups = PlaylistDuplicates.mark(tracks.map { it.id }, listOf("c"))
        val asked = mutableListOf<Pair<String, Int>>()
        val kept = PlaylistDuplicates.resolve(tracks, dups) { t, left -> asked += t.id to left; Answer(add = t.id == "b") }
        assertEquals(listOf("a" to 3, "c" to 2, "b" to 1), asked)
        assertEquals(listOf("a", "b", "b"), kept.map { it.id })
    }

    @Test fun doThisForAllAnswersEveryDuplicateLeft() = runBlocking {
        val dups = listOf(true, true, true, false, true)
        var asks = 0
        val all = PlaylistDuplicates.resolve(tracks, dups) { _, _ -> asks++; Answer(add = true, all = true) }
        assertEquals(1, asks)
        assertEquals(tracks, all)
        // Skip all that exist, after answering the first one alone.
        asks = 0
        val skip = PlaylistDuplicates.resolve(tracks, dups) { _, _ -> asks++; if (asks == 1) Answer(add = true) else Answer(add = false, all = true) }
        assertEquals(2, asks)
        assertEquals(listOf("a", "c"), skip.map { it.id })
    }

    @Test fun noDuplicatesNoQuestions() = runBlocking {
        val kept = PlaylistDuplicates.resolve(tracks, List(tracks.size) { false }) { _, _ -> error("asked") }
        assertEquals(tracks, kept)
    }

    @Test fun theToastSaysWhatHappened() {
        assertEquals(LibraryEvent.Added("Mix"), PlaylistDuplicates.event("Mix", 3, 0))
        assertEquals(LibraryEvent.AlreadyIn("Mix"), PlaylistDuplicates.event("Mix", 0, 2))
        assertEquals(LibraryEvent.AddedSkipping("Mix", 12, 3), PlaylistDuplicates.event("Mix", 12, 3))
    }
}
