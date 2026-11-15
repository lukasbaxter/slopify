package com.lukasbaxter.slopify.android.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.design.SlopifyTheme
import com.lukasbaxter.slopify.android.features.widget.WidgetLink

/** The AppModel for every screen. */
val LocalAppModel = staticCompositionLocalOf<AppModel> { error("AppModel not provided") }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val model = (application as SlopifyApplication).model
        if (savedInstanceState == null) openWidgetLink(intent)
        setContent {
            CompositionLocalProvider(LocalAppModel provides model) {
                SlopifyTheme(model.themeStore, model.account.api, model.player, model.connectivity) { RootView() }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openWidgetLink(intent)
    }

    /** A home screen widget was tapped (`slopify://widget/...`): now playing, or a recent tile's page. */
    private fun openWidgetLink(intent: Intent?) {
        val target = WidgetLink.parse(intent?.dataString) ?: return
        // Consumed, so a rotation does not open it again.
        setIntent(Intent(intent).setData(null))
        val model = (application as SlopifyApplication).model
        if (model.account.state.value != AccountState.SignedIn) return
        val nav = model.nav
        when (target) {
            WidgetLink.Target.NowPlaying -> nav.setNowPlayingOpen(true)
            is WidgetLink.Target.Page ->
                // Already on that page: only the layers over it close.
                if (nav.state.value.top?.route == target.route) { nav.setNowPlayingOpen(false); nav.setDrawerOpen(false) }
                else nav.open(target.route)
        }
    }
}
