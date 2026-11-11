package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.sheets.BottomSheet
import com.lukasbaxter.slopify.android.design.sheets.LocalCloseSheet
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import java.util.UUID

/**
 * Settings and its Scrobbling sub-page: an always-opaque `--bg-base` bar with the title always on
 * (mobile-library.css:214-217) over a `--bg-base` page. `DetailScaffold` paints `--page` behind its
 * list, which differs from `--bg-base` on Midnight/Ember/Orchid, hence this one.
 * `chevron`: 18 (top bar) or 22 in a 48 hit box (`.settings-nav`).
 */
@Composable
internal fun AccountSettingsScaffold(title: String, chevron: Dp = 18.dp, topPadding: Dp = 0.dp, content: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val nav = LocalAppModel.current.nav
    val inset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val bottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val lead = if (chevron > 18.dp) 0.dp else Spacing.gutter - 8.dp
    Box(Modifier.fillMaxSize().background(theme.bgBase)) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                .padding(top = Shell.topBar + inset + topPadding, start = Spacing.gutter, end = Spacing.gutter, bottom = 32.dp + Shell.contentBottom + bottom),
            content = content,
        )
        Row(
            Modifier.fillMaxWidth().background(theme.bgBase).padding(top = inset).height(Shell.topBar),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val back = L("Back")
            Box(
                Modifier.padding(start = lead).size(48.dp, Shell.topBar)
                    .pressable(PressFeedback.Fade) { nav.pop() }
                    .semantics { contentDescription = back },
                contentAlignment = Alignment.Center,
            ) { IconView(Icon.BackChevron, size = chevron, tint = theme.fg) }
            Text(
                title, style = TextStyles.barTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center, modifier = Modifier.weight(1f).semantics { heading() },
            )
            Spacer(Modifier.width(48.dp + lead))
        }
    }
}

/** `h2` on the phone Settings page: 16/700, 24 above, 4 below. */
@Composable
internal fun AccountSettingsHeading(title: String) {
    val theme = LocalTheme.current
    Text(title, style = TextStyles.bodyBold, color = theme.fg, modifier = Modifier.padding(top = 24.dp, bottom = 4.dp).semantics { heading() })
}

/**
 * `.setrow`: full-width row, min height 56, padding 8/0, gap 12; title 16/400, subtitle 13
 * `--fg-sub` one line; optional 16 chevron; disabled at 40 %. No press style (as the web).
 */
@Composable
internal fun AccountSettingsRow(
    title: String,
    subtitle: String?,
    chevron: Boolean = true,
    bold: Boolean = false,
    enabled: Boolean = true,
    padTop: Dp = 8.dp,
    padBottom: Dp = 8.dp,
    leading: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    val theme = LocalTheme.current
    Row(
        Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.4f)
            .pressable(PressFeedback.None, enabled = enabled, onTap = onClick)
            .heightIn(min = 56.dp).padding(top = padTop, bottom = padBottom),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = if (bold) TextStyles.bodyBold else TextStyles.body, color = theme.fg)
            if (!subtitle.isNullOrEmpty()) {
                Text(subtitle, style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (chevron) IconView(Icon.ChevronRight, size = 16.dp, tint = theme.fgSub)
    }
}

/** `.settings-caption`: 13 `--fg-sub`, line-height 1.45, margin 4 top / 16 bottom. */
@Composable
internal fun AccountSettingsCaption(text: String) {
    val theme = LocalTheme.current
    Text(text, style = TextStyle(fontSize = 13.sp, lineHeight = 1.45.em), color = theme.fgSub, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
}

/** One option of a settings sheet: the check or a theme dot in the 16 slot, then the label. */
@Immutable
internal class AccountSettingsOption(val label: String, val mark: Mark = Mark.None, val action: () -> Unit) {
    sealed interface Mark {
        data object None : Mark
        data object Check : Mark
        data class Dot(val color: Color) : Mark
    }

    val id: String = UUID.randomUUID().toString()
}

/** A settings option sheet (`settingsMenu`, UI.md 7.2.4). Tapping a row closes the sheet, then saves. */
@Immutable
internal class AccountSettingsSheet(val icon: Icon, val title: String, val subtitle: String, val options: List<AccountSettingsOption>) {
    val id: String = UUID.randomUUID().toString()
}

/** Presents `sheet` while non-null. */
@Composable
internal fun AccountSettingsSheetHost(sheet: AccountSettingsSheet?, onDismiss: () -> Unit) {
    BottomSheet(sheet, onDismiss) { s -> AccountSettingsSheetBody(s) }
}

@Composable
private fun AccountSettingsSheetBody(sheet: AccountSettingsSheet) {
    val theme = LocalTheme.current
    val close = LocalCloseSheet.current
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(bottom = 6.dp)
                .drawBehind { drawLine(theme.fg(0.1), Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx()) }
                .padding(top = 14.dp, start = 12.dp, end = 12.dp, bottom = 12.dp).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(56.dp), contentAlignment = Alignment.Center) { IconView(sheet.icon, size = 16.dp, tint = theme.fg) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(sheet.title, style = TextStyles.barTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(sheet.subtitle, style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        for (o in sheet.options) {
            Row(
                Modifier.fillMaxWidth().pressable(PressFeedback.Row) { close { o.action() } }
                    .padding(vertical = 14.dp, horizontal = 12.dp)
                    .semantics { selected = o.mark == AccountSettingsOption.Mark.Check },
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
                    when (val m = o.mark) {
                        AccountSettingsOption.Mark.Check -> IconView(Icon.Check, size = 16.dp, tint = Theme.Fixed.checkGreen)
                        is AccountSettingsOption.Mark.Dot -> Box(Modifier.size(16.dp).background(m.color, CircleShape))
                        AccountSettingsOption.Mark.None -> Unit
                    }
                }
                Text(o.label, style = TextStyles.rowTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** Pill button with a 1 border (Profile Edit / See all, History buttons): 13/700, min height 32, padding 0/16. */
@Composable
internal fun AccountOutlinePill(title: String, border: Color, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        modifier.pressable(PressFeedback.Fade, onTap = onClick)
            .heightIn(min = 32.dp)
            .border(1.dp, border, CircleShape)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg)
    }
}

/** Rounded card corner used by the History cards and charts. */
internal val AccountCardShape = RoundedCornerShape(12.dp)
