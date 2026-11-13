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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import com.lukasbaxter.slopify.android.core.stores.DuplicateQuestion
import com.lukasbaxter.slopify.android.core.stores.PlaylistDuplicates
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PrimaryButton
import com.lukasbaxter.slopify.android.design.components.SecondaryButton
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme

/**
 * "Already added" (API.md 8.2): the name prompt's card with Don't add and Add anyway, and
 * "Do this for all" while more than one duplicate is left. Tap outside or back = Don't add.
 */
@Composable
fun DuplicateDialogHost(question: DuplicateQuestion?) {
    OverlayCover(question, {}) { q, _ -> DuplicateDialogView(q) }
}

@Composable
private fun DuplicateDialogView(q: DuplicateQuestion) {
    val theme = LocalTheme.current
    var all by remember { mutableStateOf(false) }
    var appeared by remember { mutableStateOf(false) }
    var answered by remember { mutableStateOf(false) }
    val shown by animateFloatAsState(if (appeared) 1f else 0f, Motion.scrim(), label = "dialog")
    val answer = { add: Boolean, forAll: Boolean ->
        if (!answered) {
            answered = true
            q.reply(PlaylistDuplicates.Answer(add, forAll))
        }
    }
    val many = q.left > 1
    LaunchedEffect(Unit) { appeared = true }
    BackHandler { answer(false, false) }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(
            Modifier.fillMaxSize().alpha(shown).background(Theme.Fixed.sheetScrim)
                .clickable(remember { MutableInteractionSource() }, indication = null) { answer(false, false) },
        )
        Column(
            Modifier.width(min(420.dp, maxWidth - 32.dp))
                .alpha(shown)
                .shadow(12.dp, RoundedCornerShape(Radius.dialog), ambientColor = Color.Black, spotColor = Color.Black)
                .background(theme.bgElevatedHi, RoundedCornerShape(Radius.dialog))
                .clickable(remember { MutableInteractionSource() }, indication = null) {}
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(L("Already added"), style = TextStyles.dialogTitle, color = theme.fg)
            Text(L("\"{song}\" is already in {name}.", "song" to q.track.title, "name" to q.playlistName), style = TextStyles.body, color = theme.fg)
            if (many) {
                Row(
                    Modifier.fillMaxWidth().clickable(remember { MutableInteractionSource() }, indication = null) { all = !all },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = all, onCheckedChange = { all = it },
                        colors = CheckboxDefaults.colors(checkedColor = theme.accent, uncheckedColor = theme.fgSub, checkmarkColor = theme.onAccent),
                    )
                    Text(L("Do this for all"), style = TextStyles.small, color = theme.fg)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                SecondaryButton(L("Don't add")) { answer(false, many && all) }
                PrimaryButton(L("Add anyway")) { answer(true, many && all) }
            }
        }
    }
}
