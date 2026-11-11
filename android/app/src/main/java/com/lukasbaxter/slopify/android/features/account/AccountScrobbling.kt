package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Settings › Scrobbling (UI.md 7.2.3; web Library.jsx:756-781): ListenBrainz user and token. The
 * draft lives in memory only; the token is read from the account prefs, never stored here.
 */
@Composable
internal fun AccountScrobblingScreen() {
    val app = LocalAppModel.current
    val account = app.account
    val theme = LocalTheme.current
    val scope = rememberCoroutineScope()
    val focus = LocalFocusManager.current
    val prefs by account.prefs.collectAsStateWithLifecycle()
    val saved = AccountSettingsLogic.ListenBrainz.of(prefs)
    var draft by remember { mutableStateOf<AccountSettingsLogic.ListenBrainz?>(null) }
    var flash by remember { mutableIntStateOf(0) }
    var savedFlash by remember { mutableStateOf(false) }
    LaunchedEffect(flash) {
        if (flash == 0) return@LaunchedEffect
        savedFlash = true
        delay(2500)
        savedFlash = false
    }
    val d = draft ?: saved
    val dirty = AccountSettingsLogic.scrobblingDirty(d, saved)
    val tokenFocus = remember { FocusRequester() }

    fun submit() {
        focus.clearFocus()
        val clean = AccountSettingsLogic.scrobblingSubmit(d)
        scope.launch {
            account.patchPrefs(mapOf("listenbrainz" to clean.prefValue))
            draft = null
            flash++
        }
    }

    AccountSettingsScaffold(L("Scrobbling"), chevron = 22.dp, topPadding = 8.dp) {
        AccountSettingsCaption(L("Every song you play for at least half its length is sent to ListenBrainz as a listen. Get the token from listenbrainz.org, under Settings."))

        ScrobblingField(
            label = L("ListenBrainz username"), value = d.user, placeholder = L("username"),
            keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii, imeAction = ImeAction.Next),
            actions = KeyboardActions(onNext = { tokenFocus.requestFocus() }),
        ) { draft = d.copy(user = it) }
        ScrobblingField(
            label = L("ListenBrainz user token"), value = d.token, placeholder = "xxxxxxxx-xxxx-…",
            keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            actions = KeyboardActions(onDone = { if (dirty) submit() }),
            secret = true, modifier = Modifier.focusRequester(tokenFocus),
        ) { draft = d.copy(token = it) }

        Box(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 16.dp), contentAlignment = Alignment.Center) {
            Box(
                Modifier.alpha(if (dirty) 1f else 0.3f)
                    .pressable(PressFeedback.Fade, enabled = dirty) { submit() }
                    .background(theme.accent, CircleShape)
                    .heightIn(min = 48.dp).padding(horizontal = 40.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (savedFlash) L("Saved") else L("Save"), style = TextStyles.bodyBold, color = theme.onAccent)
            }
        }

        AccountSettingsCaption(AccountSettingsLogic.scrobblingStatus(saved))

        if (saved.connected) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    L("Disconnect"), style = TextStyles.smallBold, color = theme.fg,
                    modifier = Modifier.pressable(PressFeedback.Fade) {
                        focus.clearFocus()
                        draft = null
                        scope.launch { account.patchPrefs(mapOf("listenbrainz" to AccountSettingsLogic.ListenBrainz().prefValue)) }
                    }.padding(vertical = 12.dp, horizontal = 16.dp),
                )
            }
        }
    }
}

@Composable
private fun ScrobblingField(
    label: String,
    value: String,
    placeholder: String,
    keyboard: KeyboardOptions,
    actions: KeyboardActions,
    modifier: Modifier = Modifier,
    secret: Boolean = false,
    onChange: (String) -> Unit,
) {
    val theme = LocalTheme.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    Column(Modifier.padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = theme.fg)
        BasicTextField(
            value, onChange,
            modifier = modifier.fillMaxWidth(),
            singleLine = true,
            textStyle = TextStyle(fontSize = 16.sp, color = theme.fg),
            cursorBrush = SolidColor(theme.fg),
            keyboardOptions = keyboard,
            keyboardActions = actions,
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            interactionSource = interaction,
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth().height(48.dp)
                        .background(theme.chip, RoundedCornerShape(Radius.art))
                        .border(1.dp, if (focused) theme.fgDim else Color.Transparent, RoundedCornerShape(Radius.art))
                        .padding(horizontal = 12.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (value.isEmpty()) Text(placeholder, fontSize = 16.sp, color = theme.fgFaint, maxLines = 1)
                    inner()
                }
            },
        )
    }
}
