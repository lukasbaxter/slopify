package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.stores.Likes
import kotlinx.coroutines.flow.StateFlow
import java.io.File

enum class RepeatMode(val wire: String) {
    Off("off"), All("all"), One("one");
    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Off }
}

enum class ShuffleMode(val wire: String) {
    Off("off"), On("on"), Smart("smart");
    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Off }
}

/** How this phone gets the current song. */
sealed interface DeliveredProfile {
    /** A downloaded file. */
    data object File : DeliveredProfile
    /** HLS capped at `profile` (`max` of the master): aac-96 | aac-160 | aac-320 | alac. */
    data class Hls(val profile: String) : DeliveredProfile
}

/** What the UI renders, local or mirrored. Changes on user actions and track changes. */
data class PlayerState(
    val queue: List<Track> = emptyList(),
    /** Parallel to `queue`: added with "Add to queue". */
    val queuedFlags: List<Boolean> = emptyList(),
    /** Parallel to `queue`: smart-shuffle picks (web `_rec`). All false while mirroring. */
    val recFlags: List<Boolean> = emptyList(),
    val index: Int = 0,
    val isPlaying: Boolean = false,
    /** Buffering / not audible yet. */
    val isLoading: Boolean = false,
    val repeatMode: RepeatMode = RepeatMode.Off,
    val shuffle: ShuffleMode = ShuffleMode.Off,
    /** What the queue was started from: album id, playlist id, "artist:<id>", "mix:<id>", "genre:<name>". */
    val context: String? = null,
    /** 0..100. */
    val volume: Double = 100.0,
    /** Where the sound is: local, another client, or a speaker. For `local` the UI shows "This Phone". */
    val output: OutputDevice = OutputDevice.local(""),
    val remoteClientId: String? = null,
    /** Shown in the error strip until [Player.clearError]. */
    val error: String? = null,
    /** null when nothing is loaded here (mirroring, stopped). */
    val deliveredProfile: DeliveredProfile? = null,
) {
    val current: Track? get() = queue.getOrNull(index)
    /** True while mirroring another device or a speaker. */
    val isRemote: Boolean get() = output.id != "local" || remoteClientId != null
}

/** The playhead, updated about every 0.5 s while playing. Seconds. */
data class PlayerProgress(val position: Double = 0.0, val duration: Double = 0.0, val tick: Int = 0)

/**
 * What the UI talks to for playback. Plays locally when this device is the output, and
 * mirrors + remote-controls when another device or speaker is active (sends Commands
 * through SessionClient). The UI never needs to know which.
 *
 * Same public surface as ios/Slopify/Player/Player.swift. Behaviour reference:
 * web/src/player/usePlayer.js. The Media3 implementation is a later task; [NoopPlayer]
 * stands in until then.
 */
interface Player {
    val state: StateFlow<PlayerState>
    val progress: StateFlow<PlayerProgress>

    /** trackId -> downloaded file. Checked before streaming (the offline store sets it). */
    var localFile: ((trackId: String) -> File?)?
    /** Hearts for NowPlaying reports, queue items and the media session's like command. */
    var likes: Likes?
    /** A play the server could not be told about: queue it for POST /api/plays (`client: "offline"`). */
    var onOfflinePlay: ((trackId: String, at: Double) -> Unit)?

    /** Wires the player to the signed-in account and the session (AppModel calls it once). */
    fun attach(account: Account, session: SessionClient)

    /** The playhead right now (extrapolated), for lyrics and smooth progress. Seconds. */
    fun positionNow(): Double

    /** Seconds between what the engine plays and what is heard, 0..2; 0 when not local. */
    fun outputLag(): Double

    /** `shuffle` null keeps the current mode. */
    fun play(tracks: List<Track>, startAt: Int = 0, context: String? = null, shuffle: Boolean? = null)
    fun playNext(tracks: List<Track>)
    fun addToQueue(tracks: List<Track>)

    fun togglePlay()
    fun setPlaying(playing: Boolean)
    fun next()
    fun previous()
    /** Seconds. */
    fun seek(seconds: Double)
    fun skipTo(index: Int)
    fun setRepeat(mode: RepeatMode)
    fun setShuffle(mode: ShuffleMode)
    /** 0..100. */
    fun setVolume(level: Double)

    fun removeFromQueue(index: Int)
    fun moveInQueue(from: Int, to: Int)
    /** Drops every "Add to queue" row after the current song. */
    fun clearQueued()

    /** Hand playback to another client (`null` = this phone). */
    fun transferToClient(clientId: String?)
    fun transferToSpeaker(device: LanDevice)

    /** The error strip was tapped. */
    fun clearError()

    /** Touch-down on a row: fetch the start of the song's stream so a tap that follows starts fast. */
    fun prewarm(track: Track)
}
