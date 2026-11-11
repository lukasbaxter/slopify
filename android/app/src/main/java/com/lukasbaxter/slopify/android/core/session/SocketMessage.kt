package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import com.lukasbaxter.slopify.android.core.model.asArray
import com.lukasbaxter.slopify.android.core.model.asBool
import com.lukasbaxter.slopify.android.core.model.asDouble
import com.lukasbaxter.slopify.android.core.model.asObject
import com.lukasbaxter.slopify.android.core.model.asString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/** Server -> client frames (API.md §20.4). Parsed off the main thread by the transport. */
sealed interface SocketMessage {
    data class HelloOk(
        val clientId: String? = null,
        val userId: String? = null,
        val offsets: Map<String, Double> = emptyMap(),
        val now: Double? = null,
        val sleep: SleepState? = null,
    ) : SocketMessage

    data class Pong(val now: Double, val t: Double) : SocketMessage
    data class Roster(val players: List<RosterPlayer>, val lanDevices: List<LanDevice>, val activeClientId: String?) : SocketMessage
    /** `queue` null: that client withdrew its queue. */
    data class Queue(val from: String, val queue: List<QueueItem>?) : SocketMessage
    data class Session(val nowPlaying: NowPlaying, val queue: List<QueueItem>, val at: Double) : SocketMessage
    data class CommandFrom(val command: Command, val from: String) : SocketMessage
    data class Like(val itemId: String, val liked: Boolean) : SocketMessage
    data class PrefsPatch(val prefs: Prefs) : SocketMessage
    data class Sleep(val sleep: SleepState?) : SocketMessage
    data class Offset(val id: String, val offset: Double?) : SocketMessage
    data class Unknown(val type: String) : SocketMessage

    companion object {
        /**
         * null for a frame that is not a JSON object with a string `type`, or a known type
         * with a broken payload (both are ignored).
         */
        fun parse(text: String): SocketMessage? = runCatching {
            val o = SlopifyJson.parseToJsonElement(text) as? JsonObject ?: return null
            decode(o)
        }.getOrNull()

        private inline fun <reified T> JsonElement?.decodeOrNull(): T? =
            if (this == null || this is JsonNull) null else SlopifyJson.decodeFromJsonElement<T>(this)

        /** One odd entry must not hide the whole list. */
        private inline fun <reified T> JsonElement?.lossy(): List<T> =
            asArray()?.mapNotNull { runCatching { SlopifyJson.decodeFromJsonElement<T>(it) }.getOrNull() } ?: emptyList()

        private fun decode(o: JsonObject): SocketMessage {
            val type = o["type"].asString() ?: error("no type")
            return when (type) {
                "hello-ok" -> HelloOk(
                    clientId = o["clientId"].asString(),
                    userId = o["userId"].asString(),
                    offsets = o["offsets"].asObject()?.mapNotNull { (k, v) -> v.asDouble()?.let { k to it } }?.toMap() ?: emptyMap(),
                    now = o["now"].asDouble(),
                    sleep = o["sleep"].decodeOrNull(),
                )
                "pong" -> Pong(o["now"].asDouble() ?: error("now"), o["t"].asDouble() ?: error("t"))
                "roster" -> Roster(o["players"].lossy(), o["lanDevices"].lossy(), o["activeClientId"].asString())
                "queue" -> Queue(o["from"].asString() ?: error("from"), o["queue"].decodeOrNull())
                "session" -> Session(
                    nowPlaying = o["nowPlaying"].decodeOrNull() ?: error("nowPlaying"),
                    queue = o["queue"].decodeOrNull() ?: emptyList(),
                    at = o["at"].asDouble() ?: 0.0,
                )
                "command" -> CommandFrom(Command.decode(o["command"].asObject() ?: error("command")), o["from"].asString() ?: "")
                "like" -> Like(o["itemId"].asString() ?: error("itemId"), o["liked"].asBool() ?: error("liked"))
                "prefs" -> PrefsPatch(o["prefs"].asObject() ?: emptyMap())
                "sleep" -> Sleep(o["sleep"].decodeOrNull())
                "offset" -> Offset(o["id"].asString() ?: error("id"), o["offset"].asDouble())
                else -> Unknown(type)
            }
        }
    }
}
