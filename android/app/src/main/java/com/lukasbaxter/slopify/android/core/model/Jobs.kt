package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** `GET /api/ai/status` (API.md §14.2): `{ ok: true, by }` or `{ ok: false, reason }`. */
@Serializable
data class AiStatus(val ok: Boolean = false, val reason: String? = null, val by: String? = null)

/**
 * A server job (API.md §18.4): `state` is `queued | running | done | error`. `info` and `result`
 * are the job kind's own shapes, read leniently ([GenerateInfo], [GenerateResult]).
 */
@Serializable
data class ServerJob(
    val id: String,
    val kind: String? = null,
    val state: String,
    val step: String? = null,
    val progress: Double? = null,
    val info: JsonElement? = null,
    val result: JsonElement? = null,
    val error: String? = null,
    val created: Double? = null,
    val finished: Double? = null,
) {
    /** Still worth polling. */
    val active: Boolean get() = state == "queued" || state == "running"
}

/**
 * An `ai-playlist` job's `info` (server ai.ts): the stages, the server's estimate of the time
 * left, and what it has found so far. Every field is optional: it fills in as the job goes.
 */
data class GenerateInfo(
    val stages: List<Stage>? = null,
    val leftMs: Double? = null,
    val title: String? = null,
    val vibe: String? = null,
    val found: Int? = null,
    val foundNew: Int? = null,
) {
    /** `state`: `pending | active | done`. */
    data class Stage(val key: String, val label: String, val state: String, val detail: String? = null)

    companion object {
        /** null when the job has no info yet. */
        fun read(el: JsonElement?): GenerateInfo? {
            val o = el.asObject() ?: return null
            return GenerateInfo(
                stages = o["stages"].asArray()?.let { _ ->
                    o["stages"].lossyList { s ->
                        Stage(s["key"].asString() ?: return@lossyList null, s["label"].asString() ?: "", s["state"].asString() ?: "pending", s["detail"].asString())
                    }
                },
                leftMs = o["leftMs"].asDouble(),
                title = o["title"].asString(),
                vibe = o["vibe"].asString(),
                found = o["found"].asInt(),
                foundNew = o["foundNew"].asInt(),
            )
        }
    }
}

/** An `ai-playlist` job's `result` (API.md §14.2): the playlist it made or filled again. */
data class GenerateResult(
    val playlistId: String,
    val name: String,
    /** The songs of an existing playlist were replaced (Regenerate). */
    val regenerated: Boolean = false,
    val count: Int? = null,
    /** Songs still downloading that will be added later. */
    val requested: Int = 0,
) {
    companion object {
        /** null when the answer names no playlist. */
        fun read(el: JsonElement?): GenerateResult? {
            val o = el.asObject() ?: return null
            return GenerateResult(
                playlistId = o["playlistId"].asString() ?: return null,
                name = o["name"].asString() ?: "",
                regenerated = o["regenerated"].asBool() ?: false,
                count = o["count"].asInt(),
                requested = o["requested"].asInt() ?: 0,
            )
        }
    }
}
