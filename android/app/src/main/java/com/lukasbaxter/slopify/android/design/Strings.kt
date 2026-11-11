package com.lukasbaxter.slopify.android.design

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import com.lukasbaxter.slopify.android.design.i18n.Localizer

// User-facing text by its web locale key (web/src/locales), through Localizer.shared.

/** Translate an English key: `L("Added to {name}", "name" to playlist.name)`. */
fun L(key: String, vararg vars: Pair<String, Any?>): String = Localizer.shared.t(key, vars.toMap())

/** Translate with a map of values. */
fun L(key: String, vars: Map<String, Any?>): String = Localizer.shared.t(key, vars)

/** Translate and parse inline `<b>…</b>` markup (UI.md 8.1) into bold runs. */
fun LBold(key: String, vararg vars: Pair<String, Any?>): AnnotatedString = boldMarkup(L(key, vars.toMap()))

/** `<b>x</b>` -> bold `x` (split on `<b>`, then `</b>`). */
fun boldMarkup(s: String, bold: SpanStyle = SpanStyle(fontWeight = FontWeight.Bold)): AnnotatedString = buildAnnotatedString {
    val parts = s.split("<b>")
    parts.forEachIndexed { i, p ->
        if (i == 0) { append(p); return@forEachIndexed }
        val pieces = p.split("</b>")
        withStyle(bold) { append(pieces[0]) }
        if (pieces.size > 1) append(pieces.drop(1).joinToString("</b>"))
    }
}
