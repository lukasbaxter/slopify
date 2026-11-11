package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.NameId
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.session.SessionState
import kotlinx.coroutines.flow.StateFlow

/** The socket side the Player uses (SessionClient's public surface). Tests use a fake. */
interface PlayerSessionLink {
    val state: StateFlow<SessionState>
    var onCommand: ((Command, String) -> Unit)?
    fun claim()
    fun report(np: NowPlaying?)
    fun publishQueue(queue: List<QueueItem>)
    fun send(command: Command, to: String)
    fun sleepDone()
    fun playhead(np: NowPlaying): Double
}

class SessionLinkAdapter(private val session: SessionClient) : PlayerSessionLink {
    override val state: StateFlow<SessionState> get() = session.state
    override var onCommand: ((Command, String) -> Unit)?
        get() = session.onCommand
        set(v) { session.onCommand = v }
    override fun claim() = session.claim()
    override fun report(np: NowPlaying?) = session.report(np)
    override fun publishQueue(queue: List<QueueItem>) = session.publishQueue(queue)
    override fun send(command: Command, to: String) = session.send(command, to)
    override fun sleepDone() = session.sleepDone()
    override fun playhead(np: NowPlaying): Double = session.playhead(np)
}

/** Pure builders for what goes on the socket (API.md §20.5). */
object SessionReports {
    data class LocalState(
        val track: Track,
        val index: Int,
        val playing: Boolean,
        val held: Boolean,
        val position: Double,
        val duration: Double,
        val volume: Double,
        val repeatMode: RepeatMode,
        val shuffle: ShuffleMode,
        val liked: Boolean,
        val device: OutputDevice,
        val artUrl: String?,
        val now: Double,
    )

    fun nowPlaying(s: LocalState): NowPlaying {
        val t = s.track
        val credits = t.artistCredits.map { NameId(it.id, it.name) }
        return NowPlaying(
            itemId = t.id, title = t.title, artist = t.creditLine, album = t.album.ifEmpty { null },
            artUrl = s.artUrl, albumId = t.albumId.ifEmpty { null }, artistId = t.artistIds.firstOrNull(),
            artists = credits.ifEmpty { listOf(NameId(t.artistIds.firstOrNull(), t.albumArtist)) },
            liked = s.liked, device = s.device, queueIndex = s.index, playing = s.playing, held = s.playing && s.held,
            position = maxOf(0.0, s.position), duration = s.duration, volume = s.volume,
            repeat = s.repeatMode.wire, shuffle = s.shuffle.wire, at = s.now,
        )
    }

    /** Index into a published queue for a NowPlaying (§20.6: trust `queueIndex` only when it points at `itemId`). */
    fun queueIndex(np: NowPlaying, q: List<QueueItem>): Int? {
        val qi = np.queueIndex ?: return null
        return if (qi in q.indices && q[qi].id == np.itemId) qi else null
    }

    data class TakeOver(val ids: List<String>, val index: Int, val queued: List<Boolean>?)

    /** Where a take-over starts (§20.6 "Taking over onto this device"). */
    fun takeOver(np: NowPlaying, q: List<QueueItem>): TakeOver {
        val qi = queueIndex(np, q) ?: return TakeOver(listOf(np.itemId), 0, null)
        return TakeOver(q.map { it.id }, qi, q.map { it.queued ?: false })
    }
}

/** What the lock screen / notification / Bluetooth show. */
data class LockScreenInfo(
    val id: String,
    val title: String,
    val artist: String,
    val album: String,
    val duration: Double,
    /** Playhead when this was built; a seek changes it, so the session re-reads the position. */
    val elapsed: Double,
    /** Sound is meant to come out (the session extrapolates the position unless loading). */
    val playing: Boolean,
    val loading: Boolean,
    /** False when nothing is loaded here (restored, handed off): the notification goes. */
    val loaded: Boolean,
    val index: Int,
    val queue: List<Track>,
    val liked: Boolean,
    /** Cover URL (token in the query). */
    val artUrl: String?,
)

/** Remote controls from the media session (notification, lock screen, headset, car). */
class LockScreenHandlers(
    val play: () -> Boolean,
    val pause: () -> Boolean,
    val next: () -> Boolean,
    val previous: () -> Boolean,
    val seek: (Double) -> Boolean,
    val skipTo: (Int) -> Boolean,
    val like: (Boolean) -> Boolean,
    val position: () -> Double,
)

interface NowPlayingPublishing {
    fun update(info: LockScreenInfo?)
}

/** Audio focus + becoming noisy (the iOS AVAudioSession role). */
interface AudioFocusControlling {
    var onInterruptionBegan: (() -> Unit)?
    /** `shouldResume`: focus came back after a transient loss (call ended, assistant done). */
    var onInterruptionEnded: ((Boolean) -> Unit)?
    /** Headphones / Bluetooth gone: music pauses. */
    var onRouteLost: (() -> Unit)?
    /** Seconds from engine to speaker beyond what the engine's clock already includes. */
    val outputLatency: Double
    fun activate()
    fun deactivate()
}

/**
 * Mobile-data stall cap (web player/linkWatch.js): after a song starves on mobile data, the
 * next songs climb one rung lower for 10 minutes. Wi-Fi is left alone.
 */
class LinkWatch(private val cellular: () -> Boolean, private val now: () -> Double) {
    private var capUntil = 0.0

    fun noteStarve() { if (cellular()) capUntil = now() + CAP_FOR_MS }

    fun profile(p: String): String = if (cellular() && now() < capUntil) StreamPolicy.capped(p) else p

    companion object { const val CAP_FOR_MS = 10 * 60 * 1000.0 }
}
