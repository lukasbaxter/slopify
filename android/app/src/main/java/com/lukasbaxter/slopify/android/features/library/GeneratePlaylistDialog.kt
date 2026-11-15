package com.lukasbaxter.slopify.android.features.library

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.model.GenerateInfo
import com.lukasbaxter.slopify.android.core.stores.GenerateAvailability
import com.lukasbaxter.slopify.android.core.stores.GenerateBusy
import com.lukasbaxter.slopify.android.core.stores.GenerateSession
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.Chip
import com.lukasbaxter.slopify.android.design.components.PressFeedback
import com.lukasbaxter.slopify.android.design.components.PrimaryButton
import com.lukasbaxter.slopify.android.design.components.SecondaryButton
import com.lukasbaxter.slopify.android.design.components.SlopifyTextField
import com.lukasbaxter.slopify.android.design.components.pressable
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.sheets.OverlayCover
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.Motion
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import com.lukasbaxter.slopify.android.design.theme.Theme
import kotlinx.coroutines.delay
import kotlin.math.ceil
import kotlin.math.roundToInt

/** The words and numbers of the Generate dialog (GeneratePlaylist.jsx), apart from its drawing. */
internal object GenerateText {
    const val MAX_PROMPT = 1000

    /** The web's `IDEAS`, as locale keys: shown (and filled in) translated. */
    val ideas: List<String> = listOf(
        "Late night drive, R&B and slow rap",
        "Upbeat songs for the gym",
        "Like my most played lately, but songs I have not heard much",
        "Chill Sunday morning, acoustic and soft",
        "2010s pop throwbacks",
    )

    fun title(regenerate: Boolean): String = if (regenerate) L("Regenerate playlist") else L("Generated playlist")

    fun note(regenerate: Boolean): String =
        if (regenerate) L("Change the request or keep it. The songs in this playlist are replaced; a name or cover you gave it stays.")
        else L("Describe what you want. The brain finds 25 songs in your library that sound like it: 20 you have not played yet, 5 you know.")

    /** Why it cannot be used, or null when it can (or is not known yet). */
    fun unavailable(a: GenerateAvailability): String? = when (a) {
        GenerateAvailability.Loading, GenerateAvailability.Ok -> null
        is GenerateAvailability.Off -> a.reason ?: L("Generated playlists are not available on this server.")
        GenerateAvailability.Unreachable -> L("Could not reach the server.")
    }

    /** Generate / Regenerate is tappable: something typed, no job running, the server said it can. */
    fun canSubmit(prompt: String, busy: Boolean, a: GenerateAvailability): Boolean =
        prompt.isNotBlank() && !busy && a == GenerateAvailability.Ok

    /**
     * `timeLeft`: the server's estimate minus the time since it arrived, rounded up to 5 s.
     * null when the server gave no estimate.
     */
    fun timeLeft(leftMs: Double?, elapsedMs: Long): String? {
        if (leftMs == null) return null
        val ms = leftMs - elapsedMs
        if (ms < 5000) return L("Almost done")
        val s = ceil(ms / 5000).toInt() * 5
        if (s < 60) return L("About {s} s left", "s" to s)
        return if (s % 60 != 0) L("About {m} min {s} s left", "m" to s / 60, "s" to s % 60) else L("About {m} min left", "m" to s / 60)
    }

    /** The line under the bar: the countdown once the job has info, else its step ("Starting" at first). */
    fun leftLine(busy: GenerateBusy, nowMs: Long): String? {
        val i = busy.info ?: return busy.step ?: L("Starting")
        return timeLeft(i.leftMs, nowMs - busy.gotMs)
    }

    /** Whole percent of the job (0 when unknown). */
    fun percent(progress: Double?): Int = ((progress ?: 0.0) * 100).roundToInt()

    /** The bar always shows a sliver: `max(3, pct)%`, never past the end. */
    fun barFraction(progress: Double?): Float = (maxOf(3, percent(progress)).coerceAtMost(100)) / 100f

    /** What follows a stage's label: what "find" found once done, else the active stage's detail. */
    fun stageDetail(st: GenerateInfo.Stage, info: GenerateInfo): String? = when {
        st.key == "find" && st.state == "done" && (info.found ?: 0) != 0 ->
            L("{n} songs, {fresh} you have not played", "n" to info.found, "fresh" to (info.foundNew ?: 0))
        st.state == "active" && !st.detail.isNullOrEmpty() -> st.detail
        else -> null
    }

    /** The field never holds more than [MAX_PROMPT] characters (`maxLength`). */
    fun clamp(v: TextFieldValue): TextFieldValue =
        if (v.text.length <= MAX_PROMPT) v else v.copy(text = v.text.take(MAX_PROMPT), selection = TextRange(minOf(v.selection.end, MAX_PROMPT)))
}

/** Shows the Generate dialog while the app's store has one open (above every screen, like the duplicate question). */
@Composable
fun GeneratePlaylistHost() {
    val app = LocalAppModel.current
    val session by app.generate.session.collectAsStateWithLifecycle()
    OverlayCover(session, {}) { s, _ ->
        GeneratePlaylistDialog(s, onClose = { app.generate.close() }, onSubmit = { prompt -> app.generate.submit(s, prompt, app.account.api) })
    }
}

/**
 * "Generated playlist (AI)" (UI.md 6.4; GeneratePlaylist.jsx): the name prompt's card, width
 * `min(520, screen - 32)`: title, note, a 3-line request field with idea pills, then Cancel and
 * Generate; while the job runs, its progress and Hide (the job goes on without the dialog).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GeneratePlaylistDialog(s: GenerateSession, onClose: () -> Unit, onSubmit: (String) -> Unit) {
    val theme = LocalTheme.current
    val availability by s.availability.collectAsStateWithLifecycle()
    val busy by s.busy.collectAsStateWithLifecycle()
    val error by s.error.collectAsStateWithLifecycle()
    val initial = s.regenerate?.prompt ?: ""
    // Cursor at the end of what was asked last time.
    var text by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    var appeared by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val shown by animateFloatAsState(if (appeared) 1f else 0f, Motion.scrim(), label = "dialog")
    val regenerate = s.regenerate != null
    val off = GenerateText.unavailable(availability)
    val running = busy != null
    val submit = { if (GenerateText.canSubmit(text.text, running, availability)) onSubmit(text.text) }

    LaunchedEffect(Unit) { appeared = true }
    LaunchedEffect(off == null) { if (off == null) focus.requestFocus() }
    // Back is the secondary button: Cancel, or Hide while the job runs.
    BackHandler { onClose() }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // The backdrop closes it only when idle.
        Box(Modifier.fillMaxSize().alpha(shown).background(Theme.Fixed.sheetScrim).pressable(PressFeedback.None) { if (!running) onClose() })
        Column(
            Modifier.systemBarsPadding().imePadding().padding(vertical = 16.dp)
                .width(minOf(520.dp, maxWidth - 32.dp))
                .alpha(shown)
                .shadow(12.dp, RoundedCornerShape(Radius.dialog), ambientColor = Color.Black, spotColor = Color.Black)
                .background(theme.bgElevatedHi, RoundedCornerShape(Radius.dialog))
                .pressable(PressFeedback.None) {}
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // The note sits 6 closer to the title (`margin-top: -6px`).
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(GenerateText.title(regenerate), style = TextStyles.dialogTitle, color = theme.fg)
                if (off != null) Note(off) else if (!running) Note(GenerateText.note(regenerate))
            }
            if (off == null) {
                SlopifyTextField(
                    text, { text = GenerateText.clamp(it) },
                    Modifier.focusRequester(focus),
                    placeholder = L("e.g. rainy day indie, a bit melancholy"),
                    singleLine = false, minLines = 3, fontSize = 16.sp, enabled = !running,
                    onSubmit = submit,
                )
                if (!running && text.text.isEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (idea in GenerateText.ideas) {
                            val words = L(idea)
                            Chip(words, small = true) { text = TextFieldValue(words, TextRange(words.length)) }
                        }
                    }
                }
                busy?.let { GenerateProgress(it) }
                error?.let { Text(it, fontSize = 14.sp, color = theme.danger) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                SecondaryButton(if (running) L("Hide") else L("Cancel")) { onClose() }
                if (off == null) {
                    PrimaryButton(if (regenerate) L("Regenerate") else L("Generate"), enabled = GenerateText.canSubmit(text.text, running, availability), onClick = submit)
                }
            }
        }
    }
}

/** `.genpl-note`: 14 `--fg-sub`, line height 1.45. */
@Composable
private fun Note(text: String) {
    Text(text, fontSize = 14.sp, lineHeight = 1.45.em, color = LocalTheme.current.fgSub)
}

/** `.genpl-progress`: title, vibe, bar, time left, stages; gap 10. Redrawn every 500 ms for the countdown. */
@Composable
private fun GenerateProgress(busy: GenerateBusy) {
    val theme = LocalTheme.current
    val info = busy.info
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(500)
            now = System.currentTimeMillis()
        }
    }
    val fraction by animateFloatAsState(GenerateText.barFraction(busy.progress), tween(600), label = "bar")
    Column(Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        info?.title?.takeIf { it.isNotEmpty() }?.let { Text(it, style = TextStyles.bodyBold, color = theme.fg) }
        info?.vibe?.takeIf { it.isNotEmpty() }?.let { Text(it, fontSize = 13.sp, lineHeight = 1.45.em, color = theme.fgSub) }
        Box(
            Modifier.fillMaxWidth().height(4.dp).background(theme.fg(0.2), RoundedCornerShape(2.dp))
                .semantics { progressBarRangeInfo = ProgressBarRangeInfo(GenerateText.percent(busy.progress) / 100f, 0f..1f) },
        ) {
            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(theme.accent, RoundedCornerShape(2.dp)))
        }
        Text(GenerateText.leftLine(busy, now) ?: "", fontSize = 13.sp, color = theme.fgSub)
        info?.stages?.let { stages ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (st in stages) StageRow(st, GenerateText.stageDetail(st, info))
            }
        }
    }
}

/** One stage: a 16 icon slot (green check, spinner or dot) and the label, its detail in plain grey. */
@Composable
private fun StageRow(st: GenerateInfo.Stage, detail: String?) {
    val theme = LocalTheme.current
    val done = st.state == "done"
    val active = st.state == "active"
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) {
            when {
                done -> IconView(Icon.MenuCheck, size = 14.dp, tint = theme.accent)
                active -> StageSpinner()
                else -> Box(Modifier.size(6.dp).background(pendingDot, CircleShape))
            }
        }
        val label = buildAnnotatedString {
            append(st.label)
            if (detail != null) withStyle(SpanStyle(fontWeight = FontWeight.Normal, color = theme.fgSub)) { append(" · $detail") }
        }
        Text(
            label, fontSize = 14.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
            color = if (active) theme.fg else if (done) theme.fgSub else theme.fgFaint,
        )
    }
}

/** `.genpl-spin`: 16 ring, 2 wide, 25 % ink with an accent quarter turning once every 0.8 s. */
@Composable
private fun StageSpinner() {
    val theme = LocalTheme.current
    val spin by rememberInfiniteTransition(label = "spin").animateFloat(
        0f, 360f, infiniteRepeatable(tween(800, easing = LinearEasing), RepeatMode.Restart), label = "spin",
    )
    Canvas(Modifier.size(16.dp)) {
        val w = 2.dp.toPx()
        drawCircle(theme.fg(0.25), radius = size.minDimension / 2 - w / 2, style = Stroke(w))
        drawArc(theme.accent, spin - 90f, 90f, false, topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w), style = Stroke(w))
    }
}

/** `.genpl-dot` (#535353). */
private val pendingDot = RGB.hex(0x535353).color
