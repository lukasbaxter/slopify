package com.lukasbaxter.slopify.android.core.stores

import com.lukasbaxter.slopify.android.core.model.Track

/**
 * "Add to playlist" with songs already there (API.md 8.2). Every add on Android goes through
 * [LibraryStore.add], which uses these steps.
 */
object PlaylistDuplicates {
    /** The answer to one "Already added" question. `all`: the same for every duplicate left. */
    data class Answer(val add: Boolean, val all: Boolean = false)

    /** True at each place that is a duplicate: the playlist has it, or it came earlier in this batch. */
    fun mark(ids: List<String>, existing: Collection<String>): List<Boolean> {
        val seen = existing.toHashSet()
        return ids.map { !seen.add(it) }
    }

    /**
     * The songs to add, in order: every one that is not a duplicate, and the duplicates the
     * answers keep. `ask` gets the song and how many duplicates are left, this one included.
     */
    suspend fun resolve(tracks: List<Track>, dups: List<Boolean>, ask: suspend (Track, Int) -> Answer): List<Track> {
        var left = dups.count { it }
        var always: Boolean? = null
        val kept = mutableListOf<Track>()
        for ((i, t) in tracks.withIndex()) {
            if (!dups[i]) { kept += t; continue }
            val add = always ?: ask(t, left).let { a -> if (a.all) always = a.add; a.add }
            if (add) kept += t
            left -= 1
        }
        return kept
    }

    /** The toast once done. */
    fun event(name: String, added: Int, skipped: Int): LibraryEvent = when {
        skipped == 0 -> LibraryEvent.Added(name)
        added == 0 -> LibraryEvent.AlreadyIn(name)
        else -> LibraryEvent.AddedSkipping(name, added, skipped)
    }
}

/** One "Already added" question on screen; [reply] answers it. */
class DuplicateQuestion(
    val track: Track,
    val playlistName: String,
    /** Duplicates left, this one included: "Do this for all" shows when more than one. */
    val left: Int,
    val reply: (PlaylistDuplicates.Answer) -> Unit,
)
