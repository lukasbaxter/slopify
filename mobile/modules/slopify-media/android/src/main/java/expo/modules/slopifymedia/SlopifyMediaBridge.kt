package expo.modules.slopifymedia

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

// The page and the playback service talk directly, not through React Native.
// With the app in the background React Native holds the WebView's messages
// and its view commands until the app is back in front (they go out on
// screen frames, and a hidden app draws none), so the notification's pause
// never reached the page and a new song never reached the notification.
// The WebView itself keeps running in the background (the music plays in
// it), so: the page calls window.SlopifyMediaNative.update(json), and the
// service's buttons go back with evaluateJavascript.
object SlopifyMediaBridge {
  const val NAME = "SlopifyMediaNative"
  // Between songs the page says "none" for a moment: only a "none" that
  // lasts this long stops the service (as mobile/mediaSession.js did).
  private const val NONE_GRACE_MS = 10000L

  private val main = Handler(Looper.getMainLooper())
  private var webView: WeakReference<WebView>? = null
  private var appContext: Context? = null
  private var noneTimer: Runnable? = null
  private var watching: WeakReference<View>? = null

  private class Js {
    @JavascriptInterface
    fun update(json: String) {
      val m = try { toMap(JSONObject(json)) } catch (_: Exception) { return }
      main.post { onUpdate(m) }
    }
  }
  private val js = Js()

  private fun onUpdate(m: Map<String, Any?>) {
    val ctx = appContext ?: return
    if (m["state"] == "none") {
      if (noneTimer == null) {
        val r = Runnable { noneTimer = null; SlopifyMediaService.stop(ctx) }
        noneTimer = r
        main.postDelayed(r, NONE_GRACE_MS)
      }
      return
    }
    noneTimer?.let { main.removeCallbacks(it) }
    noneTimer = null
    SlopifyMediaService.update(ctx, MediaState.from(m))
  }

  // Finds the app's WebView and gives it the interface. The WebView comes
  // later than the module (and again after a server address change), so
  // every layout looks for it until it has it; the page sees the interface
  // from its next load, and uses React Native until then.
  fun watch(activity: Activity) {
    appContext = activity.applicationContext
    val root = activity.window?.decorView ?: return
    if (watching?.get() === root) { scan(root); return }
    watching = WeakReference(root)
    root.viewTreeObserver.addOnGlobalLayoutListener {
      val w = webView?.get()
      if (w == null || !w.isAttachedToWindow) scan(root)
    }
    scan(root)
  }

  private fun scan(v: View) {
    if (v is WebView) { attach(v); return }
    if (v is ViewGroup) for (i in 0 until v.childCount) scan(v.getChildAt(i))
  }

  private fun attach(w: WebView) {
    if (webView?.get() === w) return
    w.addJavascriptInterface(js, NAME)
    webView = WeakReference(w)
  }

  // A notification, lock-screen or headset press, to the page's handlers.
  // False when there is no WebView to take it (the caller falls back).
  fun deliver(action: String, seekTime: Double?): Boolean {
    val w = webView?.get() ?: return false
    if (!w.isAttachedToWindow) return false
    val detail = JSONObject().put("action", action).put("seekTime", seekTime ?: JSONObject.NULL)
    w.evaluateJavascript("window.dispatchEvent(new CustomEvent('slopify:mediaaction', { detail: $detail }));", null)
    return true
  }

  private fun toMap(o: JSONObject): Map<String, Any?> = o.keys().asSequence().associateWith { k -> unwrap(o.opt(k)) }
  private fun unwrap(v: Any?): Any? = when (v) {
    JSONObject.NULL, null -> null
    is JSONObject -> toMap(v)
    is JSONArray -> (0 until v.length()).map { unwrap(v.opt(it)) }
    else -> v
  }
}
