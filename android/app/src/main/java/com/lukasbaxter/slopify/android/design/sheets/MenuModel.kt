package com.lukasbaxter.slopify.android.design.sheets

import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.image.CoverSource
import java.util.UUID

/** One row of a context-menu sheet (ContextMenu.jsx; UI.md 5.5.3; ios Design/Sheets/MenuModel.swift). */
class MenuItem(
    val label: String = "",
    val icon: Icon? = null,
    /** Red text and icon (`--danger`): Delete. */
    val danger: Boolean = false,
    /** 40 %, not tappable. */
    val disabled: Boolean = false,
    /** Check at the right (selected option). */
    val checked: Boolean = false,
    /** Kept in the offline menu (TrackRow.jsx / Library.jsx `offline` flag). */
    val offline: Boolean = false,
    /** Tapping opens a second sheet with these rows instead of running `action`. */
    val sub: List<MenuItem>? = null,
    val kind: Kind = Kind.Action,
    val id: String = UUID.randomUUID().toString(),
    /** Runs after the sheet has closed. */
    val action: (() -> Unit)? = null,
) {
    enum class Kind { Action, Separator, Heading }

    fun copy(sub: List<MenuItem>?): MenuItem =
        MenuItem(label, icon, danger, disabled, checked, offline, sub, kind, id, action)

    companion object {
        val separator: MenuItem get() = MenuItem(kind = Kind.Separator)
        /** A label without action (12/700 `--fg-dim`). */
        fun heading(label: String) = MenuItem(label, kind = Kind.Heading)

        /** Drop separators that lead, trail or double (TrackRow.jsx / Library.jsx `heroOffline`). */
        fun tidy(items: List<MenuItem>): List<MenuItem> {
            val out = ArrayList<MenuItem>()
            for (it in items) {
                if (it.kind == Kind.Separator && (out.isEmpty() || out.last().kind == Kind.Separator)) continue
                out += it
            }
            while (out.lastOrNull()?.kind == Kind.Separator) out.removeAt(out.size - 1)
            return out
        }

        /** The offline subset: rows marked `offline`, separators tidied ("Menus reduce correctly offline"). */
        fun offlineSubset(items: List<MenuItem>): List<MenuItem> =
            tidy(items.filter { it.kind == Kind.Separator || it.offline }.map { it.sub?.let { s -> it.copy(offlineSubset(s)) } ?: it })
    }
}

/** Sheet header (UI.md 5.5.2): 56 image (round for artists) or a custom tile, title, sub. */
data class MenuHeader(val art: Art = Art.None, val title: String, val subtitle: String? = null) {
    sealed interface Art {
        data class Cover(val source: CoverSource, val round: Boolean = false) : Art
        data object Liked : Art
        data class Glyph(val icon: Icon) : Art
        data object None : Art
    }
}

/** What a context-menu sheet shows. Present with [ContextMenuSheet]. */
class MenuSheet(val header: MenuHeader? = null, val items: List<MenuItem>) {
    val id: String = UUID.randomUUID().toString()
}
