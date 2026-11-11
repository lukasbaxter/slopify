package com.lukasbaxter.slopify.android.design.theme

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * The type scale (UI.md 2.2; ios Design/Theme/Typography.swift `TextStyle`), same names. System
 * font only. Tracking is CSS letter-spacing in pt (sp here); line heights are CSS multiples.
 * Colour is left unset: pass it on the `Text`.
 */
object TextStyles {
    private fun s(size: Int, weight: FontWeight, tracking: Double = 0.0, lineHeight: Double? = null) = TextStyle(
        fontSize = size.sp,
        fontWeight = weight,
        letterSpacing = tracking.sp,
        lineHeight = lineHeight?.em ?: TextStyle.Default.lineHeight,
    )

    // Encore scale (app.css:97-104)
    val titleLg = s(48, FontWeight.Bold, -2.0)
    val titleMd = s(32, FontWeight.Bold, -1.0)
    val titleSm = s(24, FontWeight.Bold)
    val body = s(16, FontWeight.Normal)
    val bodyBold = s(16, FontWeight.Bold)
    val small = s(14, FontWeight.Normal)
    val smallBold = s(14, FontWeight.Bold)
    val marginal = s(12, FontWeight.Normal)

    // Phone roles
    /** Root page titles ("Search", "Your Library"), detail hero title: 24/700, -0.3. */
    val pageTitle = s(24, FontWeight.Bold, -0.3, 1.2)
    /** Track-row title, sheet rows: 16/400. */
    val rowTitle = s(16, FontWeight.Normal)
    /** Sub-lines under titles: 13/400 (colour `fgSub`). */
    val subLine = s(13, FontWeight.Normal)
    /** Card title: 14/700, line-height 1.3 (Home); [cardTitlePage] 1.4 elsewhere. */
    val cardTitle = s(14, FontWeight.Bold, lineHeight = 1.3)
    val cardTitlePage = s(14, FontWeight.Bold, lineHeight = 1.4)
    val cardSub = s(13, FontWeight.Normal, lineHeight = 1.3)
    /** Tab bar label: 10/500. */
    val tabLabel = s(10, FontWeight.Medium)
    /** Detail top bar title, sheet header title: 16/700. */
    val barTitle = s(16, FontWeight.Bold)
    /** Section headings (UI.md 6.0.6). */
    val sectionHome = s(24, FontWeight.Bold, -0.3, 1.2)
    val sectionSearch = s(18, FontWeight.Bold, -0.2)
    val sectionArtist = s(20, FontWeight.Bold)
    val sectionDetail = s(24, FontWeight.Bold, -0.3)
    /** Chips: 14/500 (Library chips 13/500). */
    val chip = s(14, FontWeight.Medium)
    val chipSmall = s(13, FontWeight.Medium)
    /** Buttons: 14/700. */
    val button = s(14, FontWeight.Bold)
    /** Toast: 14/500. */
    val toast = s(14, FontWeight.Medium)
    /** Mini player title 13/600 and artist 13/400, line-height 1.25. */
    val miniTitle = s(13, FontWeight.SemiBold, lineHeight = 1.25)
    val miniArtist = s(13, FontWeight.Normal, lineHeight = 1.25)
    /** Quality badge: 12/500, letter-spacing .02em. */
    val qualityBadge = s(12, FontWeight.Medium, 0.24)
    /** Dialog title: 20/700. */
    val dialogTitle = s(20, FontWeight.Bold)
    /** Menu heading-only item: 12/700. */
    val menuHeading = s(12, FontWeight.Bold)
    /** Monospace for hex values (Settings colour inputs). */
    val mono = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal, fontFamily = FontFamily.Monospace)
}
