package com.lukasbaxter.slopify.android.app

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned

/**
 * Where the Home tiles are on screen, so a list opened from the Home root (`nav.pushFromHome`)
 * zooms out of its tile and a swipe down hides it back into it (ios App/HomeZoom.swift).
 */
internal class HomeZoomSources {
    private val rects = HashMap<Route, Rect>()

    fun put(route: Route, rect: Rect) { rects[route] = rect }
    fun remove(route: Route) { rects.remove(route) }
    fun rect(route: Route): Rect? = rects[route]
}

/** Provided on the Home tab only; elsewhere [homeZoomSource] does nothing. */
internal val LocalHomeZoom = staticCompositionLocalOf<HomeZoomSources?> { null }

/**
 * Mark a Home tile as the zoom source for `route` (pair it with `nav.pushFromHome(route)`):
 *
 *     MediaCard(..., modifier = Modifier.homeZoomSource(Route.Playlist(id))) { nav.pushFromHome(Route.Playlist(id)) }
 */
fun Modifier.homeZoomSource(route: Route): Modifier = composed {
    val zoom = LocalHomeZoom.current ?: return@composed Modifier
    DisposableEffect(zoom, route) { onDispose { zoom.remove(route) } }
    Modifier.onGloballyPositioned { zoom.put(route, it.boundsInRoot()) }
}
