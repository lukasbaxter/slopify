package com.lukasbaxter.slopify.android.features.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent

// The three widgets the launcher lists under the app's name. Exact size mode: each one lays
// itself out for the cells it was given (how many tiles fit, how big the small cover is).

internal class RecentsWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { WidgetContent(WidgetKind.Recents) }
}

internal class PlayerWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { WidgetContent(WidgetKind.Player) }
}

internal class SmallWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override suspend fun provideGlance(context: Context, id: GlanceId) = provideContent { WidgetContent(WidgetKind.Small) }
}

/** 4x2: player + recents. */
class WidgetRecentsReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = RecentsWidget()
}

/** 4x1: player. */
class WidgetPlayerReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PlayerWidget()
}

/** 2x2: small. */
class WidgetSmallReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SmallWidget()
}
