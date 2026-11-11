package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Decode-only strategy that reads the whole JSON tree and hands it to [read]. For shapes
 * the app must never fail on (stats, downloads): every field is checked by hand.
 */
class LenientReader<T>(name: String, private val read: (JsonObject) -> T) : DeserializationStrategy<T> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor(name)
    override fun deserialize(decoder: Decoder): T {
        val el: JsonElement = (decoder as JsonDecoder).decodeJsonElement()
        return read(el as? JsonObject ?: JsonObject(emptyMap()))
    }
}

/** Each element through [read]; the ones that fail are skipped. */
internal inline fun <T> JsonElement?.lossyList(read: (JsonObject) -> T?): List<T> =
    asArray()?.mapNotNull { e -> e.asObject()?.let { runCatching { read(it) }.getOrNull() } } ?: emptyList()
