package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.app.Route
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.i18n.Localizer
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.overlay.ToastCenter
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Theme
import com.lukasbaxter.slopify.android.design.theme.ThemeColors
import com.lukasbaxter.slopify.android.design.theme.ThemePreset
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Phone Settings (UI.md 7.2; web Library.jsx:748-878; ios SettingsView.swift). Rows save to the
 * account at once (`patchPrefsThrowing`: optimistic, relayed to the other devices). Left out until
 * built (DECISIONS 6): theme colour pickers, Spotify import, admin settings, Logs. Log out lives
 * in the drawer.
 */
@Composable
internal fun AccountSettingsScreen() {
    val app = LocalAppModel.current
    val account = app.account
    val nav = app.nav
    val scope = rememberCoroutineScope()
    val prefs by account.prefs.collectAsStateWithLifecycle()
    val user by account.user.collectAsStateWithLifecycle()
    val colors by app.themeStore.colors.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf<AccountSettingsSheet?>(null) }
    var languagePick by remember { mutableStateOf(Localizer.shared.userPick) }
    LaunchedEffect(prefs["language"]) { languagePick = Localizer.shared.userPick }

    // App.jsx:611: a refused save toasts; the setting stays as picked.
    fun save(patch: Prefs) {
        scope.launch {
            try {
                account.patchPrefsThrowing(patch)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                ToastCenter.shared.show(L("Could not save settings: {error}", "error" to (e.message ?: e.toString())))
            }
        }
    }

    fun setTheme(c: ThemeColors) { scope.launch { app.themeStore.set(c) } }

    AccountSettingsScaffold(L("Settings")) {
        AccountSettingsRow(
            title = user?.name.orEmpty(), subtitle = L("View profile"), bold = true, padTop = 12.dp, padBottom = 16.dp,
            leading = { AccountAvatar(user?.id, user?.name, 56.dp, Theme.Fixed.drawerAvatarFallback, 22.sp, Theme.Fixed.white) },
        ) { nav.push(Route.Profile) }

        AccountSettingsHeading(L("Playback"))
        val phone = AccountSettingsLogic.QualityKey.PhoneQuality
        val other = AccountSettingsLogic.QualityKey.Quality
        AccountSettingsRow(L("Streaming quality on phones"), L(AccountSettingsLogic.quality(phone, prefs).label)) {
            sheet = qualitySheet(phone, prefs, ::save)
        }
        AccountSettingsRow(L("Streaming quality elsewhere"), L(AccountSettingsLogic.quality(other, prefs).label)) {
            sheet = qualitySheet(other, prefs, ::save)
        }
        AccountSettingsRow(
            L("Normalize volume"),
            if (AccountSettingsLogic.normalizeOn(prefs)) L("On: every song at the same loudness") else L("Off"),
            chevron = false,
        ) { save(AccountSettingsLogic.togglePatch("normalize", prefs)) }
        // DECISIONS 3: crossfade and gapless run natively, so no "Not on iPhone yet".
        AccountSettingsRow(L("Crossfade"), AccountSettingsLogic.crossfadeLabel(AccountSettingsLogic.crossfade(prefs))) {
            sheet = crossfadeSheet(prefs, ::save)
        }
        AccountSettingsRow(L("Gapless playback"), if (AccountSettingsLogic.gaplessOn(prefs)) L("On") else L("Off"), chevron = false) {
            save(AccountSettingsLogic.togglePatch("gapless", prefs))
        }

        AccountSettingsHeading(L("Scrobbling"))
        AccountSettingsRow(L("Scrobbling"), AccountSettingsLogic.scrobblingSubtitle(AccountSettingsLogic.ListenBrainz.of(prefs))) {
            nav.push(Route.Scrobbling)
        }

        AccountSettingsHeading(L("Language"))
        AccountSettingsRow(L("Language"), AccountSettingsLogic.languageLabel(languagePick)) {
            val all = listOf("" to L("Automatic")) + Localizer.languages
            sheet = AccountSettingsSheet(
                Icon.Gear, L("Language"), L("Saved to your account. Automatic follows the server, then this device."),
                all.map { (code, name) ->
                    AccountSettingsOption(name, if (code == languagePick) AccountSettingsOption.Mark.Check else AccountSettingsOption.Mark.None) {
                        // The pick switches strings live (no reload), then saves to the account.
                        Localizer.shared.setUserPick(code)
                        languagePick = code
                        save(mapOf("language" to JsonPrimitive(code)))
                    }
                },
            )
        }

        AccountSettingsHeading(L("Appearance"))
        AccountSettingsRow(L("Theme"), AccountSettingsLogic.themeLabel(colors)) {
            val current = ThemePreset.matching(colors)
            sheet = AccountSettingsSheet(
                Icon.Photo, L("Theme"), L("Applied to every Slopify you have open, instantly."),
                ThemePreset.all.map { p ->
                    val mark = if (current?.name == p.name) AccountSettingsOption.Mark.Check
                        else AccountSettingsOption.Mark.Dot(RGB.parse(p.colors.accent)?.color ?: Theme(p.colors).accent)
                    AccountSettingsOption(p.label, mark) { setTheme(p.colors) }
                },
            )
        }
        AccountSettingsRow(L("Reset to default"), null, chevron = false, enabled = AccountSettingsLogic.canReset(colors)) {
            setTheme(ThemeColors.Default)
        }
        AccountSettingsCaption(L("Saved to your account and applied to every Slopify you have open."))

        // TODO(lead): "Server" › "Server address" row (UI.md 7.2.2 #17) needs a native address screen to open.
        AccountAboutBlock()
    }
    AccountSettingsSheetHost(sheet) { sheet = null }
}

private fun qualitySheet(key: AccountSettingsLogic.QualityKey, prefs: Prefs, save: (Prefs) -> Unit): AccountSettingsSheet {
    val cur = AccountSettingsLogic.quality(key, prefs)
    val phone = key == AccountSettingsLogic.QualityKey.PhoneQuality
    return AccountSettingsSheet(
        Icon.Play,
        if (phone) L("Streaming quality on phones") else L("Streaming quality elsewhere"),
        if (phone) L("Applies from the next track on every phone signed in as you.")
        else L("Desktop and tablet. Applies from the next track. Speakers always get the original file."),
        AccountSettingsLogic.qualities.map { q ->
            AccountSettingsOption(L(q.label), if (q.id == cur.id) AccountSettingsOption.Mark.Check else AccountSettingsOption.Mark.None) {
                save(mapOf(key.wire to JsonPrimitive(q.id)))
            }
        },
    )
}

private fun crossfadeSheet(prefs: Prefs, save: (Prefs) -> Unit): AccountSettingsSheet {
    val cur = AccountSettingsLogic.crossfade(prefs)
    return AccountSettingsSheet(
        Icon.Play, L("Crossfade"), L("Songs that end by themselves fade into the next. Albums played in order stay gapless."),
        AccountSettingsLogic.crossfades.map { s ->
            AccountSettingsOption(AccountSettingsLogic.crossfadeLabel(s), if (s == cur) AccountSettingsOption.Mark.Check else AccountSettingsOption.Mark.None) {
                save(mapOf("crossfade" to JsonPrimitive(s)))
            }
        },
    )
}

/** About (UI.md 7.6.3, web components/About.jsx), phone variant: two hint paragraphs. */
@Composable
private fun AccountAboutBlock() {
    val app = LocalAppModel.current
    val theme = LocalTheme.current
    var info by remember { mutableStateOf<JsonObject?>(null) }
    LaunchedEffect(Unit) { info = attempt { app.account.api.get<JsonObject>("api/server") } }
    Column(Modifier.padding(top = 24.dp)) {
        Text(
            AccountAboutText.paragraph(AccountSettingsLogic.string(info?.get("version")), AccountSettingsLogic.string(info?.get("source")), theme.fg),
            fontSize = 14.sp, color = theme.fgDim, modifier = Modifier.padding(top = 6.dp),
        )
        Text(L("Not affiliated with Spotify."), fontSize = 14.sp, color = theme.fgDim, modifier = Modifier.padding(top = 14.dp))
    }
}
