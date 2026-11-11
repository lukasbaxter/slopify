package com.lukasbaxter.slopify.android.features.library

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import kotlin.math.max
import kotlin.math.min

/**
 * Drag to arrange Your Library: the geometry of libraryDrag.js, pure so it can be tested.
 * Rows are measured once at the lift, in the list's content coordinates, in dp.
 */
object LibraryDrag {
    // libraryDrag.js constants (px there, dp here).
    const val TOUCH_SLOP = 8f
    const val LIFT_DELAY_MS = 380L
    const val EDGE = 56f
    const val MAX_SPEED = 18f

    data class Row(val id: String, val folder: Boolean, val rect: Rect)

    data class Target(
        /** The slot among all rows the lifted one lands in. */
        val to: Int,
        /** The folder it goes into instead. */
        val into: String? = null,
    )

    /** Where row `j` sits while the lifted row (`from`) is aimed at slot `to` (`shiftOf`). */
    fun shift(rows: List<Row>, from: Int, to: Int, j: Int): Offset {
        if (j == from || j !in rows.indices) return Offset.Zero
        val k = if (j < from) j else j - 1
        val nj = if (k < to) k else k + 1
        if (nj !in rows.indices) return Offset.Zero
        val a = rows[j].rect
        val b = rows[nj].rect
        return Offset(b.left - a.left, b.top - a.top)
    }

    /**
     * The landing place for a finger at `p` (content coordinates). Over a row (where it shows
     * now): first half = before it, second half = after it, the middle of a folder = into it.
     * Over the gap the others opened: no change (no flicker). Above all = 0, below all = last.
     */
    fun target(rows: List<Row>, from: Int, current: Target, p: Offset, canEnter: Boolean): Target {
        if (rows.isEmpty()) return current
        var into: String? = null
        var to = current.to
        var over = false
        val grid = rows.any { it.rect.left != rows[0].rect.left }
        for (j in rows.indices) {
            if (j == from) continue
            val r = rows[j]
            val d = shift(rows, from, current.to, j)
            val top = r.rect.top + d.y
            val left = r.rect.left + d.x
            if (p.x < left || p.x > left + r.rect.width || p.y < top || p.y > top + r.rect.height) continue
            over = true
            val f = if (grid) (p.x - left) / r.rect.width else (p.y - top) / r.rect.height
            val g = (p.y - top) / r.rect.height
            if (r.folder && g > 0.25f && g < 0.75f && canEnter) { into = r.id; break }
            val k = if (j < from) j else j - 1
            to = if (f < 0.5f) k else k + 1
            break
        }
        if (!over && into == null) {
            val first = rows[0].rect
            val last = rows[rows.size - 1].rect
            if (p.y < first.top) to = 0 else if (p.y > last.bottom) to = rows.size - 1
        }
        return Target(to, into)
    }

    /** Auto-scroll speed (dp per frame) for a finger at `y` in a viewport of `height`. */
    fun autoScroll(y: Float, height: Float): Float {
        if (y < EDGE) return -MAX_SPEED * min(1f, (EDGE - y) / EDGE)
        if (y > height - EDGE) return MAX_SPEED * min(1f, (y - (height - EDGE)) / EDGE)
        return 0f
    }

    /**
     * The drop line: inset 4 from the slot's left, slot width - 8 (min 8), at the slot's middle.
     * Null when it lands where it started or goes into a folder.
     */
    fun dropLine(rows: List<Row>, from: Int, target: Target): Rect? {
        if (target.into != null || target.to == from || target.to !in rows.indices) return null
        val s = rows[target.to].rect
        return Rect(Offset(s.left + 4, s.center.y - 1), Size(max(8f, s.width - 8), 2f))
    }
}
