package expo.modules.slopifymedia

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The page's navigator.mediaSession (a stand-in the shell injects: Android's
// WebView has none) reaches the system through this: update() carries the
// metadata, state, position and the actions the page handles; lock-screen,
// notification and headset presses come back as onAction events.
class SlopifyMediaModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SlopifyMedia")
    Events("onAction")

    OnCreate {
      // Straight to the WebView (SlopifyMediaBridge); React Native's event
      // only when there is none, since it waits while the app is hidden.
      SlopifyMediaService.onAction = { action, seekTime ->
        if (!SlopifyMediaBridge.deliver(action, seekTime)) sendEvent("onAction", mapOf("action" to action, "seekTime" to seekTime))
      }
      appContext.currentActivity?.let { a -> a.runOnUiThread { SlopifyMediaBridge.watch(a) } }
    }
    OnActivityEntersForeground { appContext.currentActivity?.let { a -> a.runOnUiThread { SlopifyMediaBridge.watch(a) } } }
    OnDestroy { SlopifyMediaService.onAction = null }

    // The shell calls it as it starts, so the WebView gets the page-side
    // interface before the page has loaded.
    Function("watch") {
      appContext.currentActivity?.let { a -> a.runOnUiThread { SlopifyMediaBridge.watch(a) } }
    }

    Function("update") { state: Map<String, Any?> ->
      val ctx = appContext.reactContext ?: return@Function
      SlopifyMediaService.update(ctx, MediaState.from(state))
    }
    Function("stop") {
      appContext.reactContext?.let { SlopifyMediaService.stop(it) }
    }
  }
}

data class MediaState(
  val state: String, // playing | paused | none
  val title: String, val artist: String, val album: String, val artwork: String?,
  val duration: Double?, val position: Double?, val rate: Double, val at: Long,
  val actions: List<String>,
) {
  companion object {
    fun from(m: Map<String, Any?>): MediaState {
      val md = m["metadata"] as? Map<*, *>
      val pos = m["position"] as? Map<*, *>
      return MediaState(
        state = (m["state"] as? String) ?: "none",
        title = (md?.get("title") as? String).orEmpty(),
        artist = (md?.get("artist") as? String).orEmpty(),
        album = (md?.get("album") as? String).orEmpty(),
        artwork = md?.get("artwork") as? String,
        duration = (pos?.get("duration") as? Number)?.toDouble(),
        position = (pos?.get("position") as? Number)?.toDouble(),
        rate = (pos?.get("rate") as? Number)?.toDouble() ?: 1.0,
        at = (pos?.get("at") as? Number)?.toLong() ?: System.currentTimeMillis(),
        actions = (m["actions"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList(),
      )
    }
  }
}
