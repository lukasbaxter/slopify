package com.lukasbaxter.slopify.android.features.home

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.lukasbaxter.slopify.android.core.api.radio
import com.lukasbaxter.slopify.android.core.model.Radio
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.theme.Theme

/**
 * Go to radio's page (API.md §14.4): `POST /api/radio/{seedId}` makes or reuses the listener's
 * radio playlist of the seed, drawn like a Daily Mix page and started from the top once.
 * Refresh (⋯) asks for a new one.
 */
@Composable
fun RadioView(seedId: String, nameHint: String?) {
    var radio by remember(seedId) { mutableStateOf<Radio?>(null) }
    val name = radio?.seed?.name ?: nameHint
    val title = if (name.isNullOrEmpty()) "" else L("{name} Radio", "name" to name)
    HomeMixPage(
        context = "radio:$seedId",
        title = title,
        sub = radio?.let { HomeLogic.mixSub(it.artists, null) },
        color = Theme.Fixed.mixPalette[HomeLogic.radioColorIndex(seedId)],
        art = radio?.let { HomeLogic.radioArt(it.seed) },
        radioSeed = null,
        autoplay = true,
        refresh = { api -> api.radio(seedId, refresh = true).also { radio = it }.items },
    ) { api -> api.radio(seedId).also { radio = it }.items }
}
