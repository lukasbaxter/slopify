package com.lukasbaxter.slopify.android.features.account

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.theme.ThemeColors
import com.lukasbaxter.slopify.android.design.theme.ThemePreset
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * The pure parts of the phone Settings page (UI.md 7.2, web Library.jsx:748-878, api/prefs.js;
 * ios AccountSettingsLogic.swift). Every read takes the prefs map so it is testable without an Account.
 */
internal object AccountSettingsLogic {
    /** api/prefs.js `QUALITIES`; `label` is the i18n key. */
    data class Quality(val id: String, val label: String)

    val qualities = listOf(
        Quality("original", "Lossless (original file)"),
        Quality("high", "Very high (320 kbps)"),
        Quality("normal", "Normal (160 kbps)"),
        Quality("low", "Low (96 kbps)"),
    )

    /** prefs.js `CROSSFADES`. */
    val crossfades = listOf(0, 1, 2, 3, 5, 8, 12)

    enum class QualityKey(val wire: String) { PhoneQuality("phoneQuality"), Quality("quality") }

    /** A JSON string value, else null. */
    fun string(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** A JSON boolean value (not a string), else null. */
    fun bool(e: JsonElement?): Boolean? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** The selected quality; unknown ids fall back like the web (`find(...) || QUALITIES[n]`). */
    fun quality(key: QualityKey, prefs: Prefs): Quality {
        val raw = string(prefs[key.wire]).orEmpty()
        val def = if (key == QualityKey.PhoneQuality) "high" else "original"
        val id = raw.ifEmpty { def }
        return qualities.firstOrNull { it.id == id } ?: qualities.first { it.id == def }
    }

    /** `normalize !== false`. */
    fun normalizeOn(prefs: Prefs): Boolean = bool(prefs["normalize"]) != false

    /** `gapless !== false`. */
    fun gaplessOn(prefs: Prefs): Boolean = bool(prefs["gapless"]) != false

    /** `{ key: prefs.key === false }` (false -> true, anything else -> false). */
    fun togglePatch(key: String, prefs: Prefs): Prefs = mapOf(key to JsonPrimitive(bool(prefs[key]) == false))

    /** `Number(prefs.crossfade) || 0`. */
    fun crossfade(prefs: Prefs): Int {
        val p = prefs["crossfade"] as? JsonPrimitive ?: return 0
        val n = if (p.isString) p.content.trim().toDoubleOrNull() else p.doubleOrNull
        return if (n == null || !n.isFinite()) 0 else n.toInt()
    }

    /** prefs.js `crossfadeLabel`. */
    fun crossfadeLabel(seconds: Int): String = when {
        seconds <= 0 -> L("Off")
        seconds == 1 -> L("1 second")
        else -> L("{n} seconds", "n" to seconds)
    }

    /** ListenBrainz credentials as saved (`prefs.listenbrainz`). */
    data class ListenBrainz(val user: String = "", val token: String = "") {
        val connected: Boolean get() = token.isNotEmpty()
        val prefValue: JsonElement get() = JsonObject(mapOf("user" to JsonPrimitive(user), "token" to JsonPrimitive(token)))

        companion object {
            fun of(prefs: Prefs): ListenBrainz {
                val o = prefs["listenbrainz"] as? JsonObject
                return ListenBrainz(string(o?.get("user")).orEmpty(), string(o?.get("token")).orEmpty())
            }
        }
    }

    fun scrobblingSubtitle(lb: ListenBrainz): String = when {
        !lb.connected -> L("Off")
        lb.user.isEmpty() -> L("On, as your account")
        else -> L("On, as {user}", "user" to lb.user)
    }

    fun scrobblingStatus(lb: ListenBrainz): String = when {
        !lb.connected -> L("Scrobbling is off until a token is saved.")
        lb.user.isEmpty() -> L("Scrobbling as your account.")
        else -> L("Scrobbling as {user}.", "user" to lb.user)
    }

    /** Save is live only while the draft differs from what is saved. */
    fun scrobblingDirty(draft: ListenBrainz, saved: ListenBrainz): Boolean = draft != saved

    /** Submit trims both fields. */
    fun scrobblingSubmit(draft: ListenBrainz): ListenBrainz = ListenBrainz(draft.user.trim(), draft.token.trim())

    /** The native name of the stored pick, or Automatic. */
    fun languageLabel(pick: String): String = Localizer.languages.firstOrNull { it.first == pick }?.second ?: L("Automatic")

    /** The matching preset name, or Custom. */
    fun themeLabel(colors: ThemeColors): String = ThemePreset.matching(colors)?.label ?: L("Custom")

    /** "Reset to default" is off while the theme already is the default. */
    fun canReset(colors: ThemeColors): Boolean = !colors.matches(ThemeColors.Default)
}

/** About (UI.md 7.6.3, web components/About.jsx), phone variant. */
internal object AccountAboutText {
    const val DEFAULT_SOURCE = "https://github.com/lukasbaxter/slopify"
    const val LICENSE = "https://www.gnu.org/licenses/agpl-3.0.html"

    /** `{app} is free software under the <a>GNU AGPL v3</a>.` + ` Source code · What leaves your server`. */
    fun paragraph(version: String?, source: String?, fg: Color): AnnotatedString {
        val app = "Slopify" + (version?.takeIf { it.isNotEmpty() }?.let { " $it" } ?: "")
        val src = source?.takeIf { it.isNotEmpty() } ?: DEFAULT_SOURCE
        val style = TextLinkStyles(SpanStyle(color = fg, textDecoration = TextDecoration.Underline))
        return buildAnnotatedString {
            val s = L("{app} is free software under the <a>GNU AGPL v3</a>.", "app" to app)
            val open = s.indexOf("<a>")
            val close = if (open >= 0) s.indexOf("</a>", open + 3) else -1
            if (open < 0 || close < 0) append(s) else {
                append(s.substring(0, open))
                withLink(LinkAnnotation.Url(LICENSE, style)) { append(s.substring(open + 3, close)) }
                append(s.substring(close + 4))
            }
            append(" ")
            withLink(LinkAnnotation.Url(src, style)) { append(L("Source code")) }
            append(" · ")
            withLink(LinkAnnotation.Url("$src/blob/main/docs/PRIVACY.md", style)) { append(L("What leaves your server")) }
        }
    }
}
