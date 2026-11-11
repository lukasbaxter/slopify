package com.lukasbaxter.slopify.android.features.library

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.DetailScaffold
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/**
 * A Your Library folder as its own page (`Route.Folder`; ios FolderView.swift). The web's phone
 * layout opens folders in place (UI.md 5.2.9), so nothing in the library pushes this; it lists
 * the folder's things with the library rows for any link that does.
 */
@Composable
internal fun FolderScreen(id: String) {
    val ctx = rememberLibraryContext()
    val theme = LocalTheme.current
    val st by ctx.store.state.collectAsStateWithLifecycle()
    val prefs by ctx.app.account.prefs.collectAsStateWithLifecycle()
    val pinnedList = LibraryContext.pinnedOf(prefs)
    val pinned = pinnedList.toSet()
    val a = st.arrangement(pinnedList)
    val title = a.byId[id]?.name ?: L("Folder")
    LaunchedEffect(Unit) { ctx.store.refresh() }

    fun open(e: LibraryEntry) = when (e.kind) {
        LibraryEntry.Kind.Playlist -> ctx.nav.push(Route.Playlist(e.id))
        LibraryEntry.Kind.Album -> ctx.nav.push(Route.Album(e.id))
        LibraryEntry.Kind.Artist -> ctx.nav.push(Route.Artist(e.id))
        LibraryEntry.Kind.Folder -> ctx.nav.push(Route.Folder(e.id))
    }

    DetailScaffold(title) {
        item(key = "folder-title") {
            Text(title, style = TextStyles.pageTitle, color = theme.fg, modifier = Modifier.padding(horizontal = Spacing.gutter).padding(bottom = 8.dp))
        }
        items(a.kids[id].orEmpty(), key = { it.id }) { e ->
            Box(Modifier.padding(horizontal = Spacing.gutter).pressable(PressFeedback.Row) { open(e) }) {
                LibraryListRow(LibraryRowModel(e, LibraryText.subtitle(e, 0), pinned = e.id in pinned))
            }
        }
    }
}
