package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.app.LocalAppModel
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.launch

/**
 * "Your Slopify server" (UI.md 2.12, mobile/App.js ServerForm): main + home address, probed
 * before any password goes anywhere. Plus servers found on this network (API.md 4.6).
 */
@Composable
internal fun ServerAddressForm(model: SignInModel) {
    val theme = LocalTheme.current
    val s by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val browser = remember { SignInServerBrowser(context.applicationContext) }
    val found by browser.found.collectAsStateWithLifecycle()
    val scope = LocalAppModel.current.scope // outlives this form (the stage change removes it)
    val focus = LocalFocusManager.current
    val mainFocus = remember { FocusRequester() }

    DisposableEffect(browser) {
        browser.start()
        onDispose { browser.stop() }
    }
    LaunchedEffect(Unit) { if (model.state.value.main.isEmpty()) runCatching { mainFocus.requestFocus() } }

    val connect = {
        focus.clearFocus()
        scope.launch { model.connect() }
        Unit
    }

    BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) {
        val minHeight = maxHeight
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).heightIn(min = minHeight),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Column(Modifier.widthIn(max = 480.dp).fillMaxWidth().padding(horizontal = 24.dp, vertical = 64.dp)) {
                Text(L("Your Slopify server"), style = TextStyles.titleSm, color = theme.fg, modifier = Modifier.padding(bottom = 24.dp))
                ServerLabel(L("Server address"))
                // Placeholder is an example host (RFC 2606), as on the shell; not UI copy.
                ServerField(s.main, model::setMain, "music.example.com", !s.probing, connect, Modifier.focusRequester(mainFocus))
                ServerHint(L("With or without https:// in front. Slopify works it out."))
                for (f in found) FoundServer(f, enabled = !s.probing) { model.use(f.address) }
                ServerLabel(L("Home network address"))
                ServerField(s.home, model::setHome, L("Filled in for you after you sign in"), !s.probing, connect)
                ServerHint(L("At home, Slopify streams straight over your Wi-Fi from this address, and switches by itself when you leave. Leave it empty to always use the server address."))
                s.serverError?.let { e ->
                    Text(e, style = TextStyles.small, color = theme.danger, modifier = Modifier.padding(bottom = 16.dp))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                    if (s.canCancelServer) {
                        SignInTextLink(L("Cancel"), enabled = !s.probing, modifier = Modifier.padding(vertical = 10.dp, horizontal = 16.dp)) {
                            model.cancelServerEdit()
                        }
                    }
                    ConnectButton(s.probing, connect)
                }
            }
        }
    }
}

@Composable
private fun ServerLabel(text: String) {
    Text(text, style = SignInType.label, color = LocalTheme.current.fg, modifier = Modifier.padding(bottom = 8.dp))
}

@Composable
private fun ServerHint(text: String) {
    Text(text, style = SignInType.hint, color = LocalTheme.current.fgDim, modifier = Modifier.padding(bottom = 20.dp))
}

/** Shell field: `--field` fill, radius 6, 1 dp #3e3e3e, padding 12, 16; URL keyboard, Go submits. */
@Composable
private fun ServerField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onGo: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = LocalTheme.current
    BasicTextField(
        value, onValueChange,
        modifier = modifier.fillMaxWidth().padding(bottom = 20.dp),
        enabled = enabled,
        singleLine = true,
        textStyle = TextStyles.body.copy(color = theme.fg),
        cursorBrush = SolidColor(theme.fg),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Go,
        ),
        keyboardActions = KeyboardActions(onGo = { onGo() }),
        decorationBox = { inner ->
            Box(
                Modifier.background(theme.field, RoundedCornerShape(Radius.row))
                    .border(1.dp, Theme.Fixed.fieldBorder, RoundedCornerShape(Radius.row))
                    .padding(12.dp),
            ) {
                if (value.isEmpty()) Text(placeholder, style = TextStyles.body, color = theme.fgFaint, maxLines = 1)
                inner()
            }
        },
    )
}

/** Same look as the shell's "Away from home ... Use it" suggestion. */
@Composable
private fun FoundServer(f: SignInFoundServer, enabled: Boolean, onUse: () -> Unit) {
    val theme = LocalTheme.current
    val text = buildAnnotatedString {
        append(L("{name} is on this network. ", "name" to f.name))
        withStyle(SpanStyle(color = theme.green, fontWeight = FontWeight.Bold)) { append(L("Use it")) }
    }
    // Pulled up 8 under the hint above (margin-top -8), 20 below.
    Text(
        text, style = SignInType.hint, color = theme.fgDim,
        modifier = Modifier.offset(y = (-8).dp).padding(bottom = 12.dp)
            .pressable(PressFeedback.Fade, enabled = enabled, onTap = onUse),
    )
}

/** Green pill, `--on-accent` 14/700, padding 10/22; spinner at 60 % while probing. */
@Composable
private fun ConnectButton(probing: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        Modifier.alpha(if (probing) 0.6f else 1f)
            .pressable(PressFeedback.Fade, enabled = !probing, onTap = onClick)
            .background(theme.green, CircleShape)
            .padding(vertical = 10.dp, horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(L("Connect"), style = TextStyles.smallBold, color = theme.onAccent, modifier = Modifier.alpha(if (probing) 0f else 1f))
        if (probing) CircularProgressIndicator(Modifier.size(16.dp), color = theme.onAccent, strokeWidth = 2.dp)
    }
}
