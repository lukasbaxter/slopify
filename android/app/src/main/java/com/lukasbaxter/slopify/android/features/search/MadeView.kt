package com.lukasbaxter.slopify.android.features.search

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.api.made
import com.lukasbaxter.slopify.android.core.model.MadePlaylist
import com.lukasbaxter.slopify.android.design.components.CardStyle
import com.lukasbaxter.slopify.android.design.components.MediaCard
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.features.home.HomeMixArt
import com.lukasbaxter.slopify.android.features.home.HomeMixPage

/**
 * A themed playlist made for this listener (Library.jsx `openMade`): `GET /api/made/{id}`, shown
 * like a Daily Mix with the server's drawn cover (no band), its description under the title.
 * Painted from what the Search tab already shows, then from the server's answer.
 */
@Composable
fun MadeView(id: String, title: String) {
    val app = LocalAppModel.current
    val known = remember(app, id) { SearchSession.madeIfOpen(app, id) }
    var loaded by remember(id) { mutableStateOf<MadePlaylist?>(null) }
    val m = loaded ?: known
    val art = m?.art?.takeIf { it.isNotEmpty() }
    HomeMixPage(
        context = "made:$id",
        title = m?.title?.takeIf { it.isNotEmpty() } ?: title,
        sub = m?.description?.takeIf { it.isNotEmpty() },
        color = SearchLogic.madeColor(m?.color, 0),
        art = art?.let { CoverSource.AlbumArt(it, null) },
        radioSeed = null,
        drawn = art != null,
    ) { api -> api.made(id).also { loaded = it.summary }.items }
}

/** A Made For You card: the drawn cover, the title and the description under it. */
@Composable
internal fun MadeCard(m: MadePlaylist, index: Int, onClick: () -> Unit) {
    val art = m.art?.takeIf { it.isNotEmpty() }
    MediaCard(m.title, m.description ?: "", style = CardStyle.Home, onClick = onClick) {
        HomeMixArt(art?.let { CoverSource.AlbumArt(it, null) }, SearchLogic.madeColor(m.color, index), m.title, pixelSize = 150.dp, drawn = true)
    }
}
