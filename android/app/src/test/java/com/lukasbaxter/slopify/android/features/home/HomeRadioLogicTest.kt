package com.lukasbaxter.slopify.android.features.home

import com.lukasbaxter.slopify.android.core.model.MixArtist
import com.lukasbaxter.slopify.android.core.model.Radio
import com.lukasbaxter.slopify.android.design.image.CoverSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Radio page and Daily Mix subtitle rules (API.md §14.1, §14.4). */
class HomeRadioLogicTest {
    @Test fun subtitleNamesTodaysArtistsElseTheSeed() {
        assertEquals("A, B, C and more", HomeLogic.mixSub(listOf(MixArtist("1", "A"), MixArtist("2", "B"), MixArtist("3", "C")), "A"))
        assertEquals("Seed and more", HomeLogic.mixSub(emptyList(), "Seed"))
        assertNull(HomeLogic.mixSub(emptyList(), ""))
        assertNull(HomeLogic.mixSub(emptyList(), null))
    }

    @Test fun colourIsTheSeedIdsCodeUnitsSummedModEight() {
        assertEquals(("pl_ab".sumOf { it.code }) % 8, HomeLogic.radioColorIndex("pl_ab"))
        assertEquals(0, HomeLogic.radioColorIndex(""))
        assertEquals(('a'.code + 'b'.code) % 8, HomeLogic.radioColorIndex("ab"))
    }

    @Test fun coverByKind() {
        assertEquals(CoverSource.ArtistArt("ar", null), HomeLogic.radioArt(Radio.Seed("artist", "ar", "X", "ar", null)))
        assertEquals(CoverSource.AlbumArt("al", null), HomeLogic.radioArt(Radio.Seed("track", "t", "X", "ar", "al")))
        assertEquals(CoverSource.AlbumArt("al", null), HomeLogic.radioArt(Radio.Seed("album", "al", "X", "ar", "al")))
        assertEquals(CoverSource.PlaylistArt("pl_1", null), HomeLogic.radioArt(Radio.Seed("playlist", "pl_1", "X")))
    }
}
