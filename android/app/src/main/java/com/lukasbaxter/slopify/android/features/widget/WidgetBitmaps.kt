package com.lukasbaxter.slopify.android.features.widget

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Shader
import java.io.File
import kotlin.math.min

/**
 * Widget pictures. RemoteViews cannot clip an image on every Android version the app runs on,
 * so the corners (and the artists' circles) are cut into the bitmap itself.
 */
internal object WidgetBitmaps {
    /** Decoded, shaped pictures by file + shape. The same object goes into every size of a widget. */
    private val shaped = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Bitmap>?) = size > 24
    }

    /** Center-crop to a square of `px`, saved as PNG. False when the bytes are no picture. */
    fun save(bytes: ByteArray, px: Int, file: File): Boolean = runCatching {
        val src = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return false
        val side = min(src.width, src.height)
        val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
        val scaled = Bitmap.createScaledBitmap(square, px, px, true)
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.outputStream().use { scaled.compress(Bitmap.CompressFormat.PNG, 100, it) }
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
        file.exists()
    }.getOrDefault(false)

    /**
     * The saved picture at `px`, corners rounded by `corner` (radius / side; 0.5 = a circle).
     * Null when the file is gone.
     */
    @Synchronized
    fun shaped(file: File, px: Int, corner: Float): Bitmap? {
        val key = "${file.name}|${file.lastModified()}|$px|${(corner * 1000).toInt()}"
        shaped[key]?.let { return it }
        val src = runCatching { BitmapFactory.decodeFile(file.path) }.getOrNull() ?: return null
        val scaled = if (src.width == px && src.height == px) src else Bitmap.createScaledBitmap(src, px, px, true)
        val out = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
        val r = corner.coerceIn(0f, 0.5f) * px
        Canvas(out).drawRoundRect(0f, 0f, px.toFloat(), px.toFloat(), r, r, paint)
        shaped[key] = out
        return out
    }
}
