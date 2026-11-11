package com.lukasbaxter.slopify.android.design.sheets

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PrimaryButton
import com.lukasbaxter.slopify.android.design.components.SecondaryButton
import com.lukasbaxter.slopify.android.design.components.SlopifyTextField
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import java.util.UUID

/**
 * The name prompt (UI.md 2.10, 5.4.7; ios Design/Sheets/Dialogs.swift): 60 % scrim (tap =
 * cancel), centred card `--bg-elevated-hi` radius 8, padding 24, width `min(420, screen - 32)`,
 * gap 16; 20/700 title; text field with the text selected on focus; Cancel (outlined) and the
 * confirm pill (disabled while blank).
 */
class NameDialog(
    val title: String,
    val initial: String,
    val confirm: String,
    val placeholder: String = "",
    val onConfirm: (String) -> Unit,
) {
    val id: String = UUID.randomUUID().toString()
}

/** A yes/no question (`window.confirm` in the web): the platform alert with Cancel and the action. */
class ConfirmDialog(
    val message: String,
    val confirm: String,
    val destructive: Boolean = false,
    val onConfirm: () -> Unit,
) {
    val id: String = UUID.randomUUID().toString()
}

/** Presents `dialog` while non-null (New playlist, rename folder ...). */
@Composable
fun NameDialogHost(dialog: NameDialog?, onDismiss: () -> Unit) {
    OverlayCover(dialog, onDismiss) { d, close -> NameDialogView(d, close) }
}

@Composable
private fun NameDialogView(dialog: NameDialog, dismiss: (then: (() -> Unit)?) -> Unit) {
    val theme = LocalTheme.current
    var text by remember { mutableStateOf(TextFieldValue(dialog.initial, TextRange(0, dialog.initial.length))) }
    var appeared by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val shown by animateFloatAsState(if (appeared) 1f else 0f, Motion.scrim(), label = "dialog")
    val blank = text.text.isBlank()
    val submit = {
        if (!blank) {
            val name = text.text.trim()
            dismiss { dialog.onConfirm(name) }
        }
    }
    LaunchedEffect(Unit) {
        appeared = true
        focus.requestFocus()
    }
    BackHandler { dismiss(null) }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(
            Modifier.fillMaxSize().alpha(shown).background(Theme.Fixed.sheetScrim)
                .clickable(remember { MutableInteractionSource() }, indication = null) { dismiss(null) },
        )
        Column(
            Modifier.imePadding()
                .width(min(420.dp, maxWidth - 32.dp))
                .alpha(shown)
                .shadow(12.dp, RoundedCornerShape(Radius.dialog), ambientColor = Color.Black, spotColor = Color.Black)
                .background(theme.bgElevatedHi, RoundedCornerShape(Radius.dialog))
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(dialog.title, style = TextStyles.dialogTitle, color = theme.fg)
            SlopifyTextField(text, { text = it }, Modifier.focusRequester(focus), placeholder = dialog.placeholder, onSubmit = submit)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                SecondaryButton(L("Cancel")) { dismiss(null) }
                PrimaryButton(dialog.confirm, enabled = !blank, onClick = submit)
            }
        }
    }
}

/** Presents `dialog` as the platform alert while non-null. */
@Composable
fun ConfirmDialogHost(dialog: ConfirmDialog?, onDismiss: () -> Unit) {
    val d = dialog ?: return
    val theme = LocalTheme.current
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = theme.bgElevatedHi,
        textContentColor = theme.fg,
        text = { Text(d.message, fontSize = 16.sp, color = theme.fg) },
        dismissButton = { TextButton(onClick = onDismiss) { Text(L("Cancel"), color = theme.fg, fontWeight = FontWeight.Bold) } },
        confirmButton = {
            TextButton(onClick = { onDismiss(); d.onConfirm() }) {
                Text(d.confirm, color = if (d.destructive) theme.danger else theme.fg, fontWeight = FontWeight.Bold)
            }
        },
    )
}
