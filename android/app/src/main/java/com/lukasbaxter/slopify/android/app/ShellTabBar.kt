package com.lukasbaxter.slopify.android.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/**
 * UI.md 2.4 (ios ShellTabBar): three equal columns, 24 glyph (outline off, filled on), 10/500
 * label, `--fg-sub` off / `--fg` on, pressed 0.6, solid `--page`. Height 49 + the navigation
 * bar inset, padding 6 top and 4 + inset bottom (web border-box), items at the top.
 */
@Composable
internal fun ShellTabBar(lit: Tab, onSelect: (Tab) -> Unit) {
    val theme = LocalTheme.current
    val inset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Row(
        Modifier
            .fillMaxWidth()
            .height(Shell.tabBar + inset)
            .background(theme.page)
            .padding(top = 6.dp, bottom = 4.dp + inset),
        verticalAlignment = Alignment.Top,
    ) {
        for (t in Tab.entries) {
            val on = t == lit
            val color = if (on) theme.fg else theme.fgSub
            Column(
                Modifier
                    .weight(1f)
                    .wrapContentHeight(Alignment.Top, unbounded = true)
                    .semantics { role = Role.Tab; selected = on }
                    .pressable(PressFeedback.Fade) { onSelect(t) }
                    .padding(vertical = 2.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                IconView(tabIcon(t), filled = on, size = 24.dp, tint = color)
                BasicText(L(tabLabel(t)), style = TextStyles.tabLabel.copy(color = color), maxLines = 1)
            }
        }
    }
}

private fun tabIcon(t: Tab) = when (t) {
    Tab.Home -> Icon.HomeTab
    Tab.Search -> Icon.SearchTab
    Tab.Library -> Icon.LibraryTab
}

/** Web locale keys of the tab labels. */
internal fun tabLabel(t: Tab) = when (t) {
    Tab.Home -> "Home"
    Tab.Search -> "Search"
    Tab.Library -> "Your Library"
}
