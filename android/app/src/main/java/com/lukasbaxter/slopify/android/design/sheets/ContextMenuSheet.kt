package com.lukasbaxter.slopify.android.design.sheets

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.LikedCover
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/**
 * Phone context menu = bottom sheet (UI.md 5.5; ios Design/Sheets/ContextMenuSheet.swift).
 * Optional header, rows with 16 icons (`--fg-dim`; the slot disappears when no row has an
 * icon), danger / disabled / checked rows, separators and headings. A row with `sub` opens a
 * second sheet over the first (no header, at least 45 % tall, no animation); tapping the scrim
 * closes both; any action closes everything first and then runs. Shown while `menu` is non-null.
 *
 *     var menu by remember { mutableStateOf<MenuSheet?>(null) }
 *     ContextMenuSheet(menu) { menu = null }
 */
@Composable
fun ContextMenuSheet(menu: MenuSheet?, onDismiss: () -> Unit) {
    OverlayCover(menu, onDismiss) { m, dismiss ->
        SheetHost(dismiss) { ContextMenuSheetContent(m) }
    }
}

@Composable
private fun ContextMenuSheetContent(menu: MenuSheet) {
    var sub by remember { mutableStateOf<List<MenuItem>?>(null) }
    val closeSheet = LocalCloseSheet.current
    val pick: (MenuItem) -> Unit = { item ->
        if (!item.disabled && item.kind == MenuItem.Kind.Action) {
            val s = item.sub
            if (s != null) sub = s else closeSheet { item.action?.invoke() }
        }
    }
    Box(Modifier.fillMaxSize()) {
        BottomSheetFrame { MenuList(menu.header, menu.items, onPick = pick) }
        sub?.let { s -> key(s.firstOrNull()?.id) { BottomSheetFrame(sub = true) { MenuList(null, s, onPick = pick) } } }
    }
}

/** The rows of a menu, for use inside any sheet (settings option sheets reuse it). */
@Composable
fun MenuList(header: MenuHeader?, items: List<MenuItem>, modifier: Modifier = Modifier, onPick: (MenuItem) -> Unit) {
    val theme = LocalTheme.current
    val hasIcons = items.any { it.icon != null }
    Column(modifier.fillMaxWidth()) {
        header?.let { MenuHeaderView(it) }
        for (it in items) key(it.id) {
            when (it.kind) {
                MenuItem.Kind.Separator -> Box(Modifier.padding(vertical = 4.dp).fillMaxWidth().height(1.dp).background(theme.fg(0.14)))
                MenuItem.Kind.Heading -> Text(
                    it.label, style = TextStyles.menuHeading, color = theme.fgDim,
                    modifier = Modifier.padding(top = 8.dp, start = 12.dp, end = 12.dp, bottom = 4.dp),
                )
                MenuItem.Kind.Action -> MenuRow(it, hasIcons, onPick)
            }
        }
    }
}

@Composable
private fun MenuHeaderView(h: MenuHeader) {
    val theme = LocalTheme.current
    Row(
        Modifier.padding(bottom = 6.dp)
            .drawBehind { drawLine(theme.fg(0.1), Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
            .padding(top = 14.dp, start = 12.dp, end = 12.dp, bottom = 12.dp)
            .fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) {
            when (val a = h.art) {
                is MenuHeader.Art.Cover -> CoverImage(
                    a.source, 56.dp, Modifier.size(56.dp), shape = if (a.round) CoverShape.Circle else CoverShape.Rounded(Radius.art),
                )
                MenuHeader.Art.Liked -> LikedCover(Modifier.size(56.dp))
                is MenuHeader.Art.Glyph -> IconView(a.icon, size = 24.dp, tint = theme.fg)
                MenuHeader.Art.None -> Unit
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(h.title, style = TextStyles.barTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            h.subtitle?.takeIf { it.isNotEmpty() }?.let {
                Text(it, style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun MenuRow(it: MenuItem, iconSlot: Boolean, onPick: (MenuItem) -> Unit) {
    val theme = LocalTheme.current
    val color = if (it.danger) theme.danger else theme.fg
    Row(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(2.dp))
            .pressable(PressFeedback.Row, enabled = !it.disabled) { onPick(it) }
            .semantics { if (it.checked) selected = true }
            .alpha(if (it.disabled) 0.4f else 1f)
            .padding(vertical = 14.dp, horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (iconSlot) {
            Box(Modifier.size(16.dp)) {
                it.icon?.let { i -> IconView(i, size = 16.dp, tint = if (it.danger) theme.danger else theme.fgDim) }
            }
        }
        Text(it.label, fontSize = 16.sp, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.weight(1f))
        if (it.checked) IconView(Icon.MenuCheck, size = 16.dp, tint = theme.accentInk)
    }
}
