package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.SlopifyJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlin.math.roundToLong

/** Client -> server frames (API.md §20.3). */
sealed interface SocketOutgoing {
    data class Hello(
        val token: String,
        val clientId: String,
        val instance: String,
        val name: String,
        val kind: String,
        val form: String,
        val canPlay: Boolean,
    ) : SocketOutgoing

    data class Ping(val t: Double) : SocketOutgoing
    /** null is meaningful: it releases the session. */
    data class NowPlayingReport(val nowPlaying: NowPlaying?) : SocketOutgoing
    data class Queue(val queue: List<QueueItem>) : SocketOutgoing
    data class Claim(val reassertAgo: Double?) : SocketOutgoing
    data class CommandTo(val command: Command, val to: String) : SocketOutgoing
    data class PrefsPatch(val prefs: Prefs) : SocketOutgoing
    data class Sleep(val sleep: SleepRequest) : SocketOutgoing
    data class Offset(val id: String, val offset: Double?) : SocketOutgoing

    sealed interface SleepRequest {
        data class Minutes(val minutes: Int) : SleepRequest
        data object EndOfTrack : SleepRequest
        data object Off : SleepRequest
        data object Done : SleepRequest
    }

    fun json(): JsonObject = when (this) {
        is Hello -> buildJsonObject {
            put("type", "hello"); put("token", token); put("clientId", clientId); put("instance", instance)
            put("name", name); put("kind", kind); put("form", form); put("canPlay", canPlay)
        }
        is Ping -> buildJsonObject { put("type", "ping"); put("t", t) }
        is NowPlayingReport -> buildJsonObject {
            put("type", "nowplaying")
            put("nowPlaying", nowPlaying?.let { SlopifyJson.encodeToJsonElement(it) } ?: JsonNull)
        }
        is Queue -> buildJsonObject { put("type", "queue"); put("queue", SlopifyJson.encodeToJsonElement(queue)) }
        is Claim -> buildJsonObject {
            put("type", "claim")
            reassertAgo?.let { put("reassert", true); put("ago", it.roundToLong()) }
        }
        is CommandTo -> buildJsonObject { put("type", "command"); put("to", to); put("command", command.encode()) }
        is PrefsPatch -> buildJsonObject { put("type", "prefs"); put("prefs", JsonObject(prefs)) }
        is Sleep -> buildJsonObject {
            put("type", "sleep")
            when (val s = sleep) {
                is SleepRequest.Minutes -> put("minutes", s.minutes.coerceIn(1, 1440))
                SleepRequest.EndOfTrack -> put("endOfTrack", true)
                SleepRequest.Off -> put("off", true)
                SleepRequest.Done -> { put("off", true); put("done", true) }
            }
        }
        is Offset -> buildJsonObject { put("type", "offset"); put("id", id); put("offset", offset?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: JsonNull) }
    }

    fun text(): String = json().toString()
}
