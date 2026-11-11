package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * The one JSON configuration for REST and socket shapes. Unknown keys are ignored, missing
 * optionals become null, and an explicit null for a field with a default takes the default
 * (the iOS `decodeIfPresent ?? x` pattern). Nulls are left out when encoding, like Swift's
 * synthesized Codable.
 */
val SlopifyJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = true
}

/** Shallow prefs object (API.md §16). Open shape: unknown keys survive a round trip. */
typealias Prefs = Map<String, JsonElement>

// Lenient readers for open or loosely typed JSON (prefs, stats, downloads).

fun JsonElement?.asObject(): JsonObject? = this as? JsonObject
fun JsonElement?.asArray(): JsonArray? = this as? JsonArray

fun JsonElement?.asString(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

fun JsonElement?.asBool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

fun JsonElement?.asDouble(): Double? = (this as? JsonPrimitive)?.takeIf { !it.isString && this !is JsonNull }?.doubleOrNull

/** An int that may arrive as a double (rounded), like the iOS lenient decoders. */
fun JsonElement?.asInt(): Int? {
    val p = (this as? JsonPrimitive)?.takeIf { !it.isString && this !is JsonNull } ?: return null
    p.longOrNull?.let { return it.toInt() }
    val d = p.doubleOrNull ?: return null
    return if (d.isFinite()) Math.round(d).toInt() else null
}

/** A string, or a number written as one (`year` can be either on older servers). */
fun JsonElement?.asStringOrNumber(): String? {
    val p = this as? JsonPrimitive ?: return null
    if (p is JsonNull) return null
    if (p.isString) return p.content
    return p.longOrNull?.toString()
}
