package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.asBool
import com.lukasbaxter.slopify.android.core.model.asDouble
import com.lukasbaxter.slopify.android.core.model.asInt
import com.lukasbaxter.slopify.android.core.model.asString
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Client-to-client command (API.md §20.5). On the wire flat: `{ action, ...fields }`. */
sealed interface Command {
    data class Play(val trackIds: List<String>, val index: Int = 0, val ctx: String? = null, val startAt: Double? = null) : Command
    data class Transfer(val transfer: TransferPayload) : Command
    data class Enqueue(val trackIds: List<String>) : Command
    data class QueueRemove(val index: Int) : Command
    data class QueueMove(val from: Int, val to: Int) : Command
    data object QueueClear : Command
    data class SkipTo(val index: Int) : Command
    data object Toggle : Command
    data class SetPlaying(val playing: Boolean) : Command
    /** Seconds. */
    data class Seek(val pos: Double) : Command
    data class SetVolume(val level: Double) : Command
    data class VolumeStep(val step: Int) : Command
    data object Next : Command
    data object Previous : Command
    data class SetRepeat(val mode: String) : Command
    data class SetShuffle(val mode: String) : Command
    data class PatchLiked(val itemId: String, val liked: Boolean) : Command
    data object Yield : Command
    data class Unknown(val action: String) : Command

    @Serializable
    data class TransferPayload(
        val trackIds: List<String>,
        val queued: List<Boolean>? = null,
        val index: Int,
        val position: Double,
        val playing: Boolean,
        val ctx: String? = null,
        val original: List<String>? = null,
        val deviceId: String,
    )

    companion object {
        /** Throws on a known action with a broken payload. */
        fun decode(o: JsonObject): Command {
            val a = o["action"].asString() ?: error("no action")
            fun ids() = o["trackIds"]!!.jsonArray.map { it.asString() ?: error("trackIds") }
            fun int(k: String) = o[k].asInt() ?: error(k)
            fun dbl(k: String) = o[k].asDouble() ?: error(k)
            fun str(k: String) = o[k].asString() ?: error(k)
            return when (a) {
                "play" -> Play(ids(), o["index"].asInt() ?: 0, o["ctx"].asString(), o["startAt"].asDouble())
                "transfer" -> Transfer(SlopifyJson.decodeFromJsonElement(o))
                "enqueue" -> Enqueue(ids())
                "queueRemove" -> QueueRemove(int("index"))
                "queueMove" -> QueueMove(int("from"), int("to"))
                "queueClear" -> QueueClear
                "skipTo" -> SkipTo(int("index"))
                "toggle" -> Toggle
                "setPlaying" -> SetPlaying(o["playing"].asBool() ?: error("playing"))
                "seek" -> Seek(dbl("pos"))
                "setVolume" -> SetVolume(dbl("level"))
                "volumeStep" -> VolumeStep(int("step"))
                "next" -> Next
                "previous" -> Previous
                "setRepeat" -> SetRepeat(str("mode"))
                "setShuffle" -> SetShuffle(str("mode"))
                "patchLiked" -> PatchLiked(str("itemId"), o["liked"].asBool() ?: error("liked"))
                "yield" -> Yield
                else -> Unknown(a)
            }
        }

        fun decode(e: JsonElement): Command = decode(e.jsonObject)
    }
}

fun Command.encode(): JsonObject = when (this) {
    is Command.Play -> buildJsonObject {
        put("action", "play"); put("trackIds", SlopifyJson.encodeToJsonElement(trackIds)); put("index", index)
        ctx?.let { put("ctx", it) }; startAt?.let { put("startAt", it) }
    }
    is Command.Transfer -> JsonObject(SlopifyJson.encodeToJsonElement(transfer).jsonObject + ("action" to JsonPrimitive("transfer")))
    is Command.Enqueue -> buildJsonObject { put("action", "enqueue"); put("trackIds", SlopifyJson.encodeToJsonElement(trackIds)) }
    is Command.QueueRemove -> buildJsonObject { put("action", "queueRemove"); put("index", index) }
    is Command.QueueMove -> buildJsonObject { put("action", "queueMove"); put("from", from); put("to", to) }
    Command.QueueClear -> action("queueClear")
    is Command.SkipTo -> buildJsonObject { put("action", "skipTo"); put("index", index) }
    Command.Toggle -> action("toggle")
    is Command.SetPlaying -> buildJsonObject { put("action", "setPlaying"); put("playing", playing) }
    is Command.Seek -> buildJsonObject { put("action", "seek"); put("pos", pos) }
    is Command.SetVolume -> buildJsonObject { put("action", "setVolume"); put("level", level) }
    is Command.VolumeStep -> buildJsonObject { put("action", "volumeStep"); put("step", step) }
    Command.Next -> action("next")
    Command.Previous -> action("previous")
    is Command.SetRepeat -> buildJsonObject { put("action", "setRepeat"); put("mode", mode) }
    is Command.SetShuffle -> buildJsonObject { put("action", "setShuffle"); put("mode", mode) }
    is Command.PatchLiked -> buildJsonObject { put("action", "patchLiked"); put("itemId", itemId); put("liked", liked) }
    Command.Yield -> action("yield")
    is Command.Unknown -> action(action)
}

private fun action(a: String) = buildJsonObject { put("action", a) }
