package com.lukasbaxter.slopify.android.design.theme

import androidx.compose.runtime.Immutable
import com.lukasbaxter.slopify.android.design.L
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * The four colours a theme is made of (prefs `theme`, API.md §16). Everything else is derived
 * by [Theme]. Values are `#rrggbb` strings as stored on the server.
 */
@Immutable
data class ThemeColors(val accent: String, val bg: String, val surface: String, val fg: String) {

    /** For `account.patchPrefs(mapOf("theme" to colors.prefValue))`. */
    val prefValue: JsonElement
        get() = JsonObject(mapOf("accent" to JsonPrimitive(accent), "bg" to JsonPrimitive(bg), "surface" to JsonPrimitive(surface), "fg" to JsonPrimitive(fg)))

    /** prefs.js `themeEquals`: the 4 keys, case-insensitive. */
    fun matches(other: ThemeColors): Boolean =
        accent.equals(other.accent, true) && bg.equals(other.bg, true) && surface.equals(other.surface, true) && fg.equals(other.fg, true)

    companion object {
        /** prefs.js `DEFAULT_THEME` (the "Classic" preset). */
        val Default = ThemeColors(accent = "#1ed760", bg = "#121212", surface = "#1f1f1f", fg = "#ffffff")

        /** From the account prefs value; missing or malformed keys fall back per key (prefs.js applyTheme). */
        fun fromPref(pref: JsonElement?): ThemeColors {
            val o = pref as? JsonObject ?: JsonObject(emptyMap())
            fun pick(k: String, d: String): String {
                val p = o[k] as? JsonPrimitive
                val s = if (p != null && p.isString) p.contentOrNull else null
                return if (RGB.strictHex(s) != null) s!! else d
            }
            val d = Default
            return ThemeColors(pick("accent", d.accent), pick("bg", d.bg), pick("surface", d.surface), pick("fg", d.fg))
        }
    }
}

/** A named preset (prefs.js `THEME_PRESETS`). `name` is an i18n key. */
@Immutable
data class ThemePreset(val name: String, val colors: ThemeColors) {
    /** The label to show. */
    val label: String get() = L(name)

    companion object {
        val all: List<ThemePreset> = listOf(
            ThemePreset("Classic", ThemeColors.Default),
            ThemePreset("Midnight", ThemeColors("#4c8dff", "#0b1020", "#151d33", "#ffffff")),
            ThemePreset("Ember", ThemeColors("#ff7a3d", "#151010", "#241a18", "#fff5ee")),
            ThemePreset("Orchid", ThemeColors("#c77dff", "#120f18", "#1e1826", "#ffffff")),
            ThemePreset("Mono", ThemeColors("#ffffff", "#000000", "#161616", "#ffffff")),
            ThemePreset("Paper", ThemeColors("#1a7f4b", "#f4f1ea", "#ffffff", "#141414")),
        )

        /** The preset these colours equal, or null ("Custom"). */
        fun matching(c: ThemeColors): ThemePreset? = all.firstOrNull { it.colors.matches(c) }
    }
}
