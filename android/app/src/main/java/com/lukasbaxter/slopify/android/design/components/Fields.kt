package com.lukasbaxter.slopify.android.design.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Theme

/**
 * Modal text field (UI.md 2.10; ios FieldStyle.swift): padding 12/14, radius 4, 1 border #555
 * (`--fg` while focused), `--field` background, 15.
 */
@Composable
fun SlopifyTextField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
    onSubmit: (() -> Unit)? = null,
) {
    val theme = LocalTheme.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    BasicTextField(
        value, onValueChange,
        modifier = modifier.fillMaxWidth(),
        singleLine = singleLine,
        textStyle = TextStyle(fontSize = 15.sp, color = theme.fg),
        cursorBrush = SolidColor(theme.fg),
        keyboardOptions = keyboardOptions,
        keyboardActions = KeyboardActions(onDone = { onSubmit?.invoke() }),
        interactionSource = interaction,
        decorationBox = { inner -> FieldDecoration(value.text.isEmpty(), placeholder, focused, inner) },
    )
}

/** [SlopifyTextField] for plain strings. */
@Composable
fun SlopifyTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    keyboardOptions: KeyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
    onSubmit: (() -> Unit)? = null,
) {
    val theme = LocalTheme.current
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    BasicTextField(
        value, onValueChange,
        modifier = modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = TextStyle(fontSize = 15.sp, color = theme.fg),
        cursorBrush = SolidColor(theme.fg),
        keyboardOptions = keyboardOptions,
        keyboardActions = KeyboardActions(onDone = { onSubmit?.invoke() }),
        interactionSource = interaction,
        decorationBox = { inner -> FieldDecoration(value.isEmpty(), placeholder, focused, inner) },
    )
}

@Composable
private fun FieldDecoration(empty: Boolean, placeholder: String, focused: Boolean, inner: @Composable () -> Unit) {
    val theme = LocalTheme.current
    Box(
        Modifier.background(theme.field, RoundedCornerShape(Radius.art))
            .border(1.dp, if (focused) theme.fg else Theme.Fixed.textFieldBorder, RoundedCornerShape(Radius.art))
            .padding(vertical = 12.dp, horizontal = 14.dp),
    ) {
        if (empty && placeholder.isNotEmpty()) Text(placeholder, fontSize = 15.sp, color = theme.fgSub)
        inner()
    }
}

/**
 * Rounded search-style field with a leading magnifier (Library find, Liked find): `--chip`
 * background, radius 4, 16 glyph `--fg-sub`, clear button when not empty.
 */
@Composable
fun SearchField(placeholder: String, text: String, onTextChange: (String) -> Unit, modifier: Modifier = Modifier) {
    val theme = LocalTheme.current
    Row(
        modifier.fillMaxWidth().height(36.dp).background(theme.chip, RoundedCornerShape(Radius.art)).padding(start = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconView(Icon.Magnifier, size = 16.dp, tint = theme.fgSub)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (text.isEmpty()) Text(placeholder, fontSize = 14.sp, color = theme.fgSub, maxLines = 1)
            BasicTextField(
                text, onTextChange,
                singleLine = true,
                textStyle = TextStyle(fontSize = 14.sp, color = theme.fg),
                cursorBrush = SolidColor(theme.fg),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (text.isNotEmpty()) {
            val clear = L("Clear")
            Box(
                Modifier.size(28.dp).pressable(PressFeedback.Fade) { onTextChange("") }.semantics { contentDescription = clear },
                contentAlignment = Alignment.Center,
            ) { IconView(Icon.Close, size = 12.dp, tint = theme.fgSub) }
        }
    }
}
