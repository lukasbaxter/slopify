package com.lukasbaxter.slopify.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Slopify on the TV: the web app's now-playing view (cover, lyrics, visualizer)
 * in a WebView, driven by the remote. The page does the playing; this shell
 * supplies the session, the device name, and the remote keys.
 *
 * First run: `adb shell am start -n com.lukasbaxter.slopify.tv/.MainActivity --es token <token> --es userId <id>`
 * seeds the account; after that the page's own login form works too.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var nowPlayingOpen = false
    private var debugJs: String? = null
    private val prefs by lazy { getSharedPreferences("slopify", Context.MODE_PRIVATE) }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        intent?.getStringExtra("tvcss")?.let { prefs.edit().putString("tvcss", it).apply() }
        debugJs = intent?.getStringExtra("tvjs") ?: intent?.getStringExtra("tvjs64")?.let { String(android.util.Base64.decode(it, android.util.Base64.DEFAULT)) }
        intent?.getStringExtra("token")?.let { t ->
            prefs.edit().putString("token", t).putString("userId", intent.getStringExtra("userId") ?: "").apply()
        }

        web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            userAgentString = userAgentString.replace("; wv", "") + " SlopifyTV/1.0"
        }
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        web.isFocusable = true; web.isFocusableInTouchMode = true
        web.addJavascriptInterface(Bridge(), "SlopifyTV")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean { Log.i("SlopifyTV", "${m.messageLevel()} ${m.sourceId()}:${m.lineNumber()} ${m.message()}"); return true }
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(HELPER, null)
                val css = prefs.getString("tvcss", "") ?: ""
                debugJs?.let { d -> handler.postDelayed({ view.evaluateJavascript(d, null) }, 3000) }
                if (css.isNotEmpty()) view.evaluateJavascript("(function(){var s=document.getElementById('tvcss')||document.createElement('style');s.id='tvcss';s.textContent=${JSONObject.quote(css)};document.head.appendChild(s);})()", null)
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) handler.postDelayed({ view.loadUrl(BuildConfig.SERVER_URL) }, 4000)
            }
        }
        installStartScript()
        setContentView(web)
        web.loadUrl(BuildConfig.SERVER_URL)
    }

    /** Runs before the page's own scripts: identity + a seeded session, if we were given one. */
    private fun installStartScript() {
        val name = Settings.Global.getString(contentResolver, "device_name") ?: "TV"
        val token = prefs.getString("token", null)
        val userId = prefs.getString("userId", "") ?: ""
        val seed = if (token.isNullOrEmpty()) "" else {
            val session = JSONObject().put("baseUrl", "").put("token", token).put("userId", userId).toString()
            "try { if (!localStorage.getItem('slopify.session')) localStorage.setItem('slopify.session', ${JSONObject.quote(session)}); } catch (e) {}\n"
        }
        val script = """
            window.slopifyShell = { deviceName: ${JSONObject.quote(name)}, deviceForm: 'tablet', platform: 'androidtv', version: '1.0' };
            // The visualizer sizes its canvas by devicePixelRatio: at the TV's real 2x (3072x1120) this SoC managed ~5 fps,
            // at 1x it holds ~58 fps. Only the artist banner size reads this value otherwise.
            try { Object.defineProperty(window, 'devicePixelRatio', { get: () => 1, configurable: true }); } catch (e) {}
            $seed
        """.trimIndent()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, script, setOf("*"))
        } else {
            // older WebView: at least seed before the first navigation completes
            web.evaluateJavascript(script, null)
        }
    }

    inner class Bridge {
        @JavascriptInterface fun state(nowPlaying: Boolean) { nowPlayingOpen = nowPlaying }
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript("window.__tv && window.__tv.$code", null) }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val down = event.action == KeyEvent.ACTION_DOWN
        // Media keys always drive the player; the d-pad only while the now-playing view is up
        // (on the login form it must move the cursor and type).
        when (event.keyCode) {
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> { if (down && event.repeatCount == 0) js("toggle()"); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (down && event.repeatCount == 0) js("next()"); return true }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND -> { if (down && event.repeatCount == 0) js("prev()"); return true }
        }
        if (nowPlayingOpen) when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { if (down && event.repeatCount == 0) js("toggle()"); return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> { if (down && event.repeatCount == 0) js("next()"); return true }
            KeyEvent.KEYCODE_DPAD_LEFT -> { if (down && event.repeatCount == 0) js("prev()"); return true }
            KeyEvent.KEYCODE_DPAD_UP -> { if (down && event.repeatCount == 0) js("tab(-1)"); return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { if (down && event.repeatCount == 0) js("tab(1)"); return true }
        }
        if (event.keyCode == KeyEvent.KEYCODE_BACK) { if (down) finish(); return true }
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() { web.destroy(); super.onDestroy() }

    companion object {
        /** Page-side helper. Uses the app's own controls so behaviour matches a click. */
        val HELPER = """
            (function () {
              if (window.__tv) return;
              // 1080p at 320 dpi is only 960 css px; lay the page out at 1600 (desktop-like, a touch larger for TV distance) and let the WebView scale it.
              let vp = document.querySelector('meta[name="viewport"]');
              if (!vp) { vp = document.createElement('meta'); vp.name = 'viewport'; document.head.appendChild(vp); }
              vp.content = 'width=1600, initial-scale=' + (screen.width / 1600) + ', minimum-scale=' + (screen.width / 1600) + ', maximum-scale=' + (screen.width / 1600);
              console.log('slopify-tv viewport', window.innerWidth, 'x', window.innerHeight, 'dpr', window.devicePixelRatio);
              let frames = 0, last = performance.now();
              const fpsLoop = () => { frames++; const now = performance.now(); if (now - last >= 10000) { console.log('slopify-tv fps ' + (frames * 1000 / (now - last)).toFixed(1) + ' tab=' + (document.querySelector('.fs-tabs button[aria-pressed="true"]')?.getAttribute('aria-label') || '-')); frames = 0; last = now; } requestAnimationFrame(fpsLoop); };
              requestAnimationFrame(fpsLoop);
              if (!document.getElementById('tvcss-base')) { const st = document.createElement('style'); st.id = 'tvcss-base'; st.textContent = '.fs-close{display:none!important} .fs-lyrics{width:min(1200px,100%)!important} .fs-lyrics .lyric-line,.fs-lyrics p{font-size:40px!important} .fs-art{max-width:min(66vh,90vw)!important}'; document.head.appendChild(st); }
              const q = (s) => document.querySelector(s);
              const click = (s) => { const b = q(s); if (b && !b.disabled) { b.click(); return true; } return false; };
              const TABS = ['Album', 'Lyrics', 'Visualizer'];
              window.__tv = {
                open() { if (!q('.fs-top')) click('button[title="Now playing view"]'); },
                toggle() { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true })); },
                next() { click('button[title="Next"]'); },
                prev() { click('button[title="Previous"]'); },
                tab(d) {
                  const btns = TABS.map((l) => q('.fs-tabs button[aria-label="' + l + '"]')).filter(Boolean);
                  if (!btns.length) return;
                  const i = btns.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
                  const n = (i + d + btns.length) % btns.length;
                  if (n !== i) btns[n].click();
                },
              };
              setInterval(() => {
                const open = !!q('.fs-top');
                try { SlopifyTV.state(open); } catch (e) {}
                if (!open && localStorage.getItem('slopify.session')) window.__tv.open();
              }, 1000);
            })();
        """
    }
}
