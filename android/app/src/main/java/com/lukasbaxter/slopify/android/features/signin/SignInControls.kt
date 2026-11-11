package com.lukasbaxter.slopify.android.features.signin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles

/** Sign-in type that has no shared role: derived from the Encore scale. */
internal object SignInType {
    /** `.login h1` on the phone: 28/800, -0.5. */
    val heading = TextStyles.titleSm.copy(fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp)
    /** `.login-sub`: 15. */
    val subtitle = TextStyles.body.copy(fontSize = 15.sp)
    /** Server screen labels and text links: 14/600. */
    val label = TextStyles.small.copy(fontWeight = FontWeight.SemiBold)
    /** Server screen hints: 13, line height 18. */
    val hint = TextStyles.subLine.copy(lineHeight = 18.sp)
}

/** What a sign-in field holds, for the keyboard and autofill. */
internal enum class SignInFieldKind { Username, Password, NewPassword }

/**
 * `.login input` on the phone (app.css:1400): `--page` fill, 1 dp `--fg-faint` border (`--fg`
 * focused), radius 4, padding 14, 16.
 */
@Composable
internal fun LoginField(
    value: String,
    onValueChange: (String) -> Unit,
    kind: SignInFieldKind,
    imeAction: ImeAction,
    onIme: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val theme = LocalTheme.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val secret = kind != SignInFieldKind.Username
    val autofill = when (kind) {
        SignInFieldKind.Username -> ContentType.Username
        SignInFieldKind.Password -> ContentType.Password
        SignInFieldKind.NewPassword -> ContentType.NewPassword
    }
    BasicTextField(
        value, onValueChange,
        modifier = modifier.fillMaxWidth().semantics { contentType = autofill },
        singleLine = true,
        textStyle = TextStyles.body.copy(color = theme.fg),
        cursorBrush = SolidColor(theme.fg),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = if (secret) KeyboardType.Password else KeyboardType.Ascii,
            imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onNext = { onIme() }, onGo = { onIme() }, onDone = { onIme() }),
        interactionSource = interaction,
        decorationBox = { inner ->
            Box(
                Modifier.background(theme.page, RoundedCornerShape(Radius.art))
                    .border(1.dp, if (focused) theme.fg else theme.fgFaint, RoundedCornerShape(Radius.art))
                    .padding(14.dp),
            ) { inner() }
        },
    )
}

/** `.login label`: 14/700 `--fg` above its field, gap 8. */
@Composable
internal fun LoginLabeled(title: String, field: @Composable () -> Unit) {
    val theme = LocalTheme.current
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = TextStyles.smallBold, color = theme.fg)
        field()
    }
}

/** `.login .primary`: full-width `--accent` pill, `--on-accent` 16/700, min height 48, 30 % disabled. */
@Composable
internal fun LoginButton(title: String, enabled: Boolean, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(
        Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 48.dp)
            .alpha(if (enabled) 1f else 0.3f)
            .pressable(PressFeedback.Fade, enabled = enabled, onTap = onClick)
            .background(theme.accent, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(title, style = TextStyles.bodyBold, color = theme.onAccent)
    }
}

/** `.login h1` + `.login-sub` on the phone: 28/800 -0.5 centred, then 15 `--fg-sub`, margin-bottom 16. */
@Composable
internal fun LoginHeading(title: String, subtitle: String) {
    val theme = LocalTheme.current
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(title, style = SignInType.heading, color = theme.fg, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Text(
            subtitle, style = SignInType.subtitle, color = theme.fgSub, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
        )
    }
}

/** `.login` page on the phone: black, top aligned, padding-top 80 + inset, form padding 0/24, gap 16. */
@Composable
internal fun LoginPage(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize()
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .verticalScroll(rememberScrollState())
            .padding(start = 24.dp, end = 24.dp, top = 80.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        content = content,
    )
}

/** A centred text link (14/600 `--fg-dim`), e.g. "Server address" under the form. */
@Composable
internal fun SignInTextLink(title: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Text(
        title, style = SignInType.label, color = theme.fgDim,
        modifier = modifier.pressable(PressFeedback.Fade, enabled = enabled, onTap = onClick),
    )
}
