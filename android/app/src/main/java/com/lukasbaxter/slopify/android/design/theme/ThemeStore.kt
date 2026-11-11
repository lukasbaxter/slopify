package com.lukasbaxter.slopify.android.design.theme

import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

/**
 * Follows `account.prefs["theme"]` (live, including patches from other devices) and hands out
 * the derived [Theme]. The root reads [theme] (`SlopifyTheme(store)`).
 */
class ThemeStore(
    prefs: StateFlow<Prefs>,
    scope: CoroutineScope,
    private val patch: suspend (Prefs) -> Unit = {},
) {
    constructor(account: Account, scope: CoroutineScope) : this(account.prefs, scope, { account.patchPrefs(it) })

    /** Colours to use while not signed in or before prefs load. */
    val fallback = MutableStateFlow(ThemeColors.Default)

    /** The account's theme colours, else [fallback]. */
    val colors: StateFlow<ThemeColors> = combine(prefs, fallback) { p, f -> p["theme"]?.let { ThemeColors.fromPref(it) } ?: f }
        .distinctUntilChanged()
        .stateIn(scope, SharingStarted.Eagerly, prefs.value["theme"]?.let { ThemeColors.fromPref(it) } ?: fallback.value)

    val theme: StateFlow<Theme> = colors.map { Theme(it) }.stateIn(scope, SharingStarted.Eagerly, Theme(colors.value))

    /** The preset the current colours equal, or null for "Custom". */
    val preset: ThemePreset? get() = ThemePreset.matching(colors.value)

    /** Save a theme to the account (other devices apply it live via the relay). */
    suspend fun set(c: ThemeColors) = patch(mapOf("theme" to c.prefValue))
}
