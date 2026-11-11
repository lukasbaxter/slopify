package com.lukasbaxter.slopify.android.features.account

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.sheets.OverlayLayer
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlin.math.abs

/** Drawer gestures, pure for tests. */
internal object AccountDrawerLogic {
    /** App.jsx:1605-1611: dx < -50 and |dx| > 1.5 |dy|. */
    fun isCloseSwipe(dx: Float, dy: Float): Boolean = dx < -50 && abs(dx) > abs(dy) * 1.5f
}

/**
 * The phone account drawer (UI.md 2.7, 7.1; web App.jsx:1594-1640, app.css:1205-1223): scrim
 * `rgba(0,0,0,.55)` fading in, a `--page` panel `min(82 %, 340)` wide sliding in from the left
 * over 0.25 s, above the tab bar and mini player. Tap the scrim or swipe left to close; Log out
 * sits at the bottom. Follows `nav.drawerOpen` itself, so the shell may compose it always.
 */
@Composable
internal fun AccountDrawerLayer() {
    val app = LocalAppModel.current
    val nav = app.nav
    val open = nav.state.collectAsStateWithLifecycle().value.drawerOpen
    val shown = remember { Animatable(0f) }
    LaunchedEffect(open) {
        if (open) shown.animateTo(1f, Motion.drawerIn()) else shown.animateTo(0f, tween(200))
    }
    if (!open && shown.value == 0f) return
    OverlayLayer { AccountDrawerPanel(shown.value) { nav.setDrawerOpen(false) } }
}

@Composable
private fun AccountDrawerPanel(shown: Float, close: () -> Unit) {
    val app = LocalAppModel.current
    val nav = app.nav
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val user by app.account.user.collectAsStateWithLifecycle()
    val onClose by rememberUpdatedState(close)
    val insets = WindowInsets.safeDrawing.asPaddingValues()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = minOf(maxWidth * 0.82f, 340.dp)
        val height = maxHeight
        val closeLabel = L("Close")
        Box(
            Modifier.fillMaxSize().graphicsLayer { alpha = shown }.background(Theme.Fixed.drawerScrim)
                .clickable(remember { MutableInteractionSource() }, indication = null) { onClose() }
                .semantics { contentDescription = closeLabel },
        )
        Column(
            Modifier.width(width).fillMaxHeight()
                .graphicsLayer { translationX = -(1f - shown) * with(density) { (width + 60.dp).toPx() } }
                .shadow(30.dp)
                .background(theme.page)
                // a tap on the panel never reaches the scrim
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .pointerInput(Unit) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        while (true) {
                            val e = awaitPointerEvent()
                            val c = e.changes.firstOrNull { it.id == down.id } ?: break
                            val d = c.position - down.position
                            if (AccountDrawerLogic.isCloseSwipe(d.x / density.density, d.y / density.density)) { onClose(); break }
                            if (!c.pressed) break
                        }
                    }
                }
                .verticalScroll(rememberScrollState()),
        ) {
            run {
                Column(
                    Modifier.fillMaxWidth().heightIn(min = height)
                        .padding(top = 24.dp + insets.calculateTopPadding(), bottom = 24.dp + insets.calculateBottomPadding()),
                ) {
                    val name = user?.name?.takeIf { it.isNotEmpty() }
                    Row(
                        Modifier.padding(bottom = 8.dp).fillMaxWidth()
                            .pressable(PressFeedback.Fade) { nav.open(Route.Profile) }
                            .padding(top = 8.dp, start = 20.dp, end = 20.dp, bottom = 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AccountAvatar(user?.id, user?.name, 56.dp, Theme.Fixed.drawerAvatarFallback, 22.sp, Theme.Fixed.white)
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(name ?: L("Signed in"), fontSize = 20.sp, fontWeight = FontWeight.Bold, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(L("View profile"), style = TextStyles.subLine, color = theme.fgSub, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    DrawerRow(Icon.DrawerHistory, L("Listening history")) { nav.open(Route.History) }
                    DrawerRow(Icon.DrawerDownloads, L("Downloads")) { nav.open(Route.Downloads) }
                    DrawerRow(Icon.DrawerSettings, L("Settings")) { nav.open(Route.Settings) }
                    Spacer(Modifier.weight(1f))
                    DrawerRow(Icon.DrawerLogOut, L("Log out")) {
                        onClose()
                        app.account.signOut()
                    }
                }
            }
        }
    }
}

@Composable
private fun DrawerRow(icon: Icon, title: String, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Row(
        Modifier.fillMaxWidth().pressable(PressFeedback.Fade, onTap = onClick).padding(vertical = 14.dp, horizontal = 20.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconView(icon, size = 24.dp, tint = theme.fg)
        Text(title, style = TextStyles.body, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
