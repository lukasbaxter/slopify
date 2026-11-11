package com.lukasbaxter.slopify.android.features.library

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.PrimaryButton
import com.lukasbaxter.slopify.android.design.components.SlopifyTextField
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.launch
import java.util.UUID

/** What the full-screen naming page names (Sidebar.jsx `naming`). */
data class LibraryNaming(val kind: Kind, val name: String = "", val key: String = UUID.randomUUID().toString()) {
    sealed interface Kind {
        data object Playlist : Kind
        data object Folder : Kind
        data class Rename(val id: String) : Kind
    }

    val title: String
        get() = when (kind) {
            Kind.Playlist -> L("Give your playlist a name")
            Kind.Folder -> L("Give your folder a name")
            is Kind.Rename -> L("Rename folder")
        }
    val placeholder: String get() = if (kind == Kind.Playlist) L("My playlist #1") else L("My folder")
    val confirm: String get() = if (kind is Kind.Rename) L("Save") else L("Create")
}

/**
 * `.newpl` (UI.md 5.2.10): page colour, centred column gap 24, 24/700 title, a big centred
 * field with a bottom hairline, Cancel + white Create pill (30 % while blank). No animation.
 */
@Composable
internal fun LibraryNamingPage(naming: LibraryNaming, close: (then: (() -> Unit)?) -> Unit, onSubmit: (LibraryNaming, String) -> Unit) {
    val theme = LocalTheme.current
    var text by remember { mutableStateOf(naming.name) }
    val focus = remember { FocusRequester() }
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val trimmed = text.trim()
    val submit = { if (trimmed.isNotEmpty()) close { onSubmit(naming, trimmed) } }
    BackHandler { close(null) }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Box(
        Modifier.fillMaxSize().background(theme.page).pressable(PressFeedback.None) {}.systemBarsPadding().imePadding().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(naming.title, style = TextStyles.pageTitle, color = theme.fg, textAlign = TextAlign.Center)
            Spacer(Modifier.height(24.dp))
            val hairline = if (focused) theme.fg else theme.fgFaint
            BasicTextField(
                text, { text = it },
                singleLine = true,
                textStyle = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.Bold, color = theme.fg, textAlign = TextAlign.Center),
                cursorBrush = SolidColor(theme.fg),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                interactionSource = interaction,
                modifier = Modifier.widthIn(max = 340.dp).fillMaxWidth().focusRequester(focus)
                    .drawBehind { drawLine(hairline, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
                    .padding(top = 8.dp, bottom = 12.dp),
                decorationBox = { inner ->
                    Box(contentAlignment = Alignment.Center) {
                        if (text.isEmpty()) Text(naming.placeholder, fontSize = 24.sp, fontWeight = FontWeight.Bold, color = theme.fgFaint, textAlign = TextAlign.Center, maxLines = 1)
                        inner()
                    }
                },
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    L("Cancel"), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = theme.fg,
                    modifier = Modifier.pressable(PressFeedback.Fade) { close(null) }.padding(horizontal = 12.dp, vertical = 8.dp),
                )
                Box(
                    Modifier.alpha(if (trimmed.isEmpty()) 0.3f else 1f)
                        .pressable(PressFeedback.Fade, enabled = trimmed.isNotEmpty()) { submit() }
                        .defaultMinSize(minHeight = 48.dp)
                        .background(theme.fg, CircleShape)
                        .padding(horizontal = 32.dp),
                    contentAlignment = Alignment.Center,
                ) { Text(naming.confirm, fontSize = 16.sp, fontWeight = FontWeight.Bold, color = theme.onFg) }
            }
        }
    }
}

/** What the Edit details dialog edits. */
data class LibraryEditDetails(val id: String, val cover: String?, val name: String)

/**
 * Edit details (UI.md 6.3.11): 60 % scrim (tap = close, no save), card `--bg-elevated-hi`
 * radius 8, padding 24, width `min(524, screen - 32)`, gap 16; title 20/700; 180 cover picker;
 * name field; Save pill (40 % while blank).
 */
@Composable
internal fun LibraryEditDetailsDialog(
    edit: LibraryEditDetails,
    jpegOf: suspend (Uri) -> ByteArray?,
    close: (then: (() -> Unit)?) -> Unit,
    onSave: (name: String, jpeg: ByteArray?) -> Unit,
) {
    val theme = LocalTheme.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(edit.name) }
    var preview by remember { mutableStateOf<ImageBitmap?>(null) }
    var jpeg by remember { mutableStateOf<ByteArray?>(null) }
    var appeared by remember { mutableStateOf(false) }
    val shown by animateFloatAsState(if (appeared) 1f else 0f, Motion.scrim(), label = "edit")
    val trimmed = name.trim()
    val save = { if (trimmed.isNotEmpty()) { val n = trimmed; val j = jpeg; close { onSave(n, j) } } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) scope.launch {
            val data = jpegOf(uri) ?: return@launch
            preview = BitmapFactory.decodeByteArray(data, 0, data.size)?.asImageBitmap()
            jpeg = data
        }
    }
    BackHandler { close(null) }
    LaunchedEffect(Unit) { appeared = true }
    BoxWithConstraints(Modifier.fillMaxSize().imePadding(), contentAlignment = Alignment.Center) {
        Box(Modifier.fillMaxSize().alpha(shown).background(Theme.Fixed.sheetScrim).pressable(PressFeedback.None) { close(null) })
        Column(
            Modifier.width(minOf(524.dp, maxWidth - 32.dp)).alpha(shown)
                .shadow(12.dp, RoundedCornerShape(Radius.dialog))
                .background(theme.bgElevatedHi, RoundedCornerShape(Radius.dialog))
                .pressable(PressFeedback.None) {}
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(L("Edit details"), style = TextStyles.dialogTitle, color = theme.fg)
            val choose = L("Choose photo")
            Box(
                Modifier.size(180.dp).shadow(20.dp, RoundedCornerShape(Radius.art)).clip(RoundedCornerShape(Radius.art)).background(theme.cardHover)
                    .pressable(PressFeedback.None) { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                    .semantics { contentDescription = choose },
            ) {
                val p = preview
                if (p != null) Image(p, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                else CoverImage(CoverSource.PlaylistArt(edit.id, edit.cover), 180.dp, Modifier.fillMaxSize(), shape = CoverShape.Rounded(Radius.art), placeholder = CoverPlaceholder.CardHover)
            }
            SlopifyTextField(name, { name = it }, placeholder = L("Add a name"), onSubmit = { save() })
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                PrimaryButton(L("Save"), enabled = trimmed.isNotEmpty()) { save() }
            }
        }
    }
}
