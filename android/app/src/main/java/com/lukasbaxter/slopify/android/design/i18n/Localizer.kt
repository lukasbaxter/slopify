package com.lukasbaxter.slopify.android.design.i18n

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import com.lukasbaxter.slopify.android.R
import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import com.lukasbaxter.slopify.android.core.storage.MemoryStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.Locale

/**
 * The app's words in the person's language (UI.md 8; ios Design/Localization/Localizer.swift).
 * The English text is the key; the translation comes from the bundled web locale JSON
 * (res/raw/locale_*.json, copied by android/tools/sync-locales.sh), falling back to the
 * English. `{name}` placeholders are filled from `vars`; a placeholder with no value stays
 * literal.
 *
 * Language = the person's pick (`prefs.language`), else the server default (`/api/i18n`), else
 * the device languages, else English. Changing it swaps the table live: [language] is
 * snapshot state, so composables that call [L] recompose.
 */
class Localizer(
    private val store: KeyValueStore = MemoryStore(),
    private val loader: (String) -> Map<String, String> = { emptyMap() },
    private val preferred: () -> List<String> = { deviceLanguages() },
) {
    private val languageState = mutableStateOf("en")
    @Volatile private var dict: Map<String, String> = emptyMap()
    private var following: Job? = null

    /** The resolved language code in use. */
    val language: String get() = languageState.value

    /** The person's pick ("" = Automatic), cached on the device. */
    val userPick: String get() = store.getString(USER_KEY).orEmpty()
    /** The server's default, last seen. */
    val serverDefault: String get() = store.getString(SERVER_KEY).orEmpty()

    /** For locale-aware formatting (counts, dates) in the app's language. */
    val locale: Locale get() = Locale.forLanguageTag(language)

    init { apply() }

    // Lookup

    fun t(key: String, vars: Map<String, Any?> = emptyMap()): String {
        languageState.value // read: recompose on a language change
        // i18n.js `(dict && dict[s]) || s`: an empty translation falls back too.
        val raw = dict[key]?.takeIf { it.isNotEmpty() } ?: key
        return fill(raw, vars)
    }

    // Choosing the language

    /** Set the person's pick ("" = Automatic) and switch now. Saving it to the account is Settings' job. */
    fun setUserPick(code: String) {
        store.putString(USER_KEY, code.ifEmpty { null })
        apply()
    }

    /** Fetch `/api/i18n` (public) and switch if the server default changes what is shown. */
    suspend fun refreshServerDefault(api: ApiClient) {
        val r = attempt { api.get<JsonObject>("api/i18n") } ?: return
        val v = (r["language"] as? JsonPrimitive)?.contentOrNull.orEmpty()
        store.putString(SERVER_KEY, if (v.isEmpty() || v == "auto") null else v)
        apply()
    }

    /** Follow `prefs.language` live (also picks arriving from other devices). */
    fun follow(prefs: StateFlow<Prefs>, scope: CoroutineScope) {
        following?.cancel()
        following = scope.launch {
            prefs.map { (it["language"] as? JsonPrimitive)?.contentOrNull }.distinctUntilChanged().collect { pick ->
                if (pick != null && pick != userPick) setUserPick(if (pick == "auto") "" else pick)
            }
        }
    }

    /** Re-resolve and load the table. */
    fun apply() {
        val code = resolve(userPick, serverDefault, preferred())
        dict = if (code == "en") emptyMap() else loader(code)
        if (languageState.value != code) languageState.value = code
    }

    /** Test hook: use this table directly. */
    fun install(table: Map<String, String>, language: String) {
        dict = table
        languageState.value = language
    }

    companion object {
        /** `LANGUAGES` from web/src/i18n.js, in Settings picker order. Names are not translated. */
        val languages: List<Pair<String, String>> = listOf(
            "en" to "English", "es" to "Español", "fr" to "Français", "de" to "Deutsch", "it" to "Italiano",
            "pt-BR" to "Português (Brasil)", "nl" to "Nederlands", "pl" to "Polski", "ru" to "Русский",
            "uk" to "Українська", "tr" to "Türkçe", "sv" to "Svenska", "da" to "Dansk", "nb" to "Norsk bokmål",
            "fi" to "Suomi", "cs" to "Čeština", "ja" to "日本語", "ko" to "한국어", "zh-CN" to "简体中文",
            "zh-TW" to "繁體中文", "id" to "Bahasa Indonesia", "vi" to "Tiếng Việt",
        )

        const val USER_KEY = "slopify.lang.user"
        const val SERVER_KEY = "slopify.lang.server"

        @Volatile var shared: Localizer = Localizer()
            private set

        /** Once, at launch: the bundled tables and the device store. */
        fun install(context: Context, store: KeyValueStore) {
            val res = context.applicationContext.resources
            shared = Localizer(store, { code -> RAW[code]?.let { id -> parse(res.openRawResource(id).use { it.readBytes() }.decodeToString()) } ?: emptyMap() })
        }

        /** The bundled table files (tools/sync-locales.sh keeps them in step with web/src/locales). */
        val RAW: Map<String, Int> = mapOf(
            "es" to R.raw.locale_es, "fr" to R.raw.locale_fr, "de" to R.raw.locale_de, "it" to R.raw.locale_it,
            "pt-BR" to R.raw.locale_pt_br, "nl" to R.raw.locale_nl, "pl" to R.raw.locale_pl, "ru" to R.raw.locale_ru,
            "uk" to R.raw.locale_uk, "tr" to R.raw.locale_tr, "sv" to R.raw.locale_sv, "da" to R.raw.locale_da,
            "nb" to R.raw.locale_nb, "fi" to R.raw.locale_fi, "cs" to R.raw.locale_cs, "ja" to R.raw.locale_ja,
            "ko" to R.raw.locale_ko, "zh-CN" to R.raw.locale_zh_cn, "zh-TW" to R.raw.locale_zh_tw,
            "id" to R.raw.locale_id, "vi" to R.raw.locale_vi,
        )

        /** A locale JSON (flat `{ english: translation }`); non-strings are skipped. */
        fun parse(json: String): Map<String, String> {
            val o = runCatching { SlopifyJson.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return emptyMap()
            return o.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { k to it } }.toMap()
        }

        /** The phone's languages in order (LocaleList); the JVM default when there is none (tests). */
        fun deviceLanguages(): List<String> {
            val list: android.os.LocaleList? = runCatching { android.os.LocaleList.getDefault() }.getOrNull()
            val tags = list?.let { l -> (0 until l.size()).mapNotNull { l[it]?.toLanguageTag() } }.orEmpty()
            return tags.ifEmpty { listOf(Locale.getDefault().toLanguageTag()) }
        }

        private val NAME = Regex("^\\w+$")

        /** `{name}` replacement (i18n.js `t`): only `\w+` names; unknown names stay literal. */
        fun fill(s: String, vars: Map<String, Any?>): String {
            if (vars.isEmpty() || !s.contains('{')) return s
            val out = StringBuilder()
            var i = 0
            while (i < s.length) {
                if (s[i] == '{') {
                    val close = s.indexOf('}', i)
                    if (close > i + 1) {
                        val name = s.substring(i + 1, close)
                        if (NAME.matches(name)) {
                            val v = vars[name]
                            if (v != null) out.append(v.toString()) else out.append(s, i, close + 1)
                            i = close + 1
                            continue
                        }
                    }
                }
                out.append(s[i]); i++
            }
            return out.toString()
        }

        /** i18n.js `match`: the closest shipped language for a code like `pt`, `pt-PT`, `zh-Hant-TW`, `no`. */
        fun match(code: String?): String? {
            if (code.isNullOrEmpty() || code == "auto") return null
            val c = code.replaceFirst('_', '-').lowercase()
            languages.firstOrNull { it.first.lowercase() == c }?.let { return it.first }
            if (c.startsWith("zh")) return if (Regex("tw|hk|mo|hant").containsMatchIn(c)) "zh-TW" else "zh-CN"
            if (c == "no" || c.startsWith("nn") || c.startsWith("no-") || c.startsWith("nb")) return "nb"
            val base = c.split('-').first()
            return languages.firstOrNull { it.first.lowercase().split('-').first() == base }?.first
        }

        /** i18n.js `resolve`. */
        fun resolve(user: String?, server: String?, device: List<String>): String =
            match(user) ?: match(server) ?: device.firstNotNullOfOrNull { match(it) } ?: "en"
    }
}

