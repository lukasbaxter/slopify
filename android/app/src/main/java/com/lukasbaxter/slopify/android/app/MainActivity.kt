package com.lukasbaxter.slopify.android.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import com.lukasbaxter.slopify.android.design.SlopifyTheme

/** The AppModel for every screen. */
val LocalAppModel = staticCompositionLocalOf<AppModel> { error("AppModel not provided") }

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val model = (application as SlopifyApplication).model
        setContent {
            CompositionLocalProvider(LocalAppModel provides model) {
                SlopifyTheme(model.themeStore, model.account.api, model.player, model.connectivity) { RootView() }
            }
        }
    }
}
