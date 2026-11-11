package com.lukasbaxter.slopify.android.design

import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ImageBitmapConfig
import androidx.compose.ui.graphics.colorspace.ColorSpace
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import com.lukasbaxter.slopify.android.core.model.Track
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * design/ColorFixtures.json (test resources): outputs of the web's own JS on fixed inputs, made by
 * ios/tools/color-fixtures.mjs and shared with the iOS tests (SlopifyTests/Design).
 */
object DesignFixtures {
    val root: JsonObject by lazy {
        val text = DesignFixtures::class.java.getResourceAsStream("/design/ColorFixtures.json")!!.readBytes().decodeToString()
        Json.parseToJsonElement(text).jsonObject
    }

    val sets: Map<String, IntArray> by lazy {
        root["sets"]!!.jsonObject.mapValues { (_, v) -> v.jsonArray.map { it.jsonPrimitive.int }.toIntArray() }
    }

    fun ints(e: JsonElement?): List<Int>? = if (e == null || e is JsonNull) null else e.jsonArray.map { it.jsonPrimitive.double.toInt() }
    fun doubles(e: JsonElement): List<Double> = e.jsonArray.map { it.jsonPrimitive.double }
    fun str(e: JsonElement?): String = (e as JsonPrimitive).content
    fun list(key: String): JsonArray = root[key]!!.jsonArray
}

/** A decoded image stand-in (no Android Bitmap on the JVM). */
class DesignFakeBitmap(override val width: Int = 4, override val height: Int = 4) : ImageBitmap {
    override val colorSpace: ColorSpace = ColorSpaces.Srgb
    override val hasAlpha: Boolean = false
    override val config: ImageBitmapConfig = ImageBitmapConfig.Argb8888
    override fun readPixels(buffer: IntArray, startX: Int, startY: Int, width: Int, height: Int, bufferOffset: Int, stride: Int) = Unit
    override fun prepareToDraw() = Unit
}

fun designTrack(
    id: String,
    artists: List<String> = listOf("A"),
    ids: List<String> = listOf("a1"),
    album: String = "Alb",
    albumId: String = "al1",
) = Track(
    id = id, title = "T$id", artist = artists.joinToString(", "), artists = artists, artistIds = ids, albumId = albumId, album = album,
    albumArtist = artists.firstOrNull() ?: "", durationMs = 1000,
)
