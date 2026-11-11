package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.model.ArtistDetail
import com.lukasbaxter.slopify.android.core.model.Gain
import com.lukasbaxter.slopify.android.core.model.Mix
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.NameId
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.SessionConnection
import com.lukasbaxter.slopify.android.core.session.SessionState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlin.random.Random

fun playerTrack(id: String, album: String = "al1", artistId: String = "ar1", ms: Int = 200_000, gain: Gain? = null) = Track(
    id = id, title = "T$id", artist = "Artist", artists = listOf("Artist"), artistIds = listOf(artistId), albumId = album,
    album = "Album", albumArtist = "Artist", durationMs = ms, gain = gain,
)

fun playerTracks(vararg ids: String) = ids.map { playerTrack(it) }

class PlayerFakeEngine : AudioEngine {
    override var events: AudioEngineEvents? = null
    override var currentId: String? = null
    override var currentTime = 0.0
    var playing = false
    var level = 1f
    val loads = mutableListOf<Triple<AudioItem, Double, Boolean>>()
    var next: Pair<AudioItem?, AudioTransition>? = null
    var unloads = 0
    val seeks = mutableListOf<Double>()

    override fun load(item: AudioItem, at: Double, play: Boolean) {
        loads += Triple(item, at, play); currentId = item.id; currentTime = at; playing = play
    }
    override fun setNext(item: AudioItem?, transition: AudioTransition) { next = item to transition }
    override fun play() { playing = true }
    override fun pause() { playing = false }
    override fun seek(seconds: Double) { seeks += seconds; currentTime = seconds }
    override fun setVolume(v: Float) { level = v }
    override fun unload() { unloads++; currentId = null; playing = false }
}

class PlayerFakeLink : PlayerSessionLink {
    override val state = MutableStateFlow(SessionState(connection = SessionConnection.Connected, clientId = "me"))
    override var onCommand: ((Command, String) -> Unit)? = null
    var claims = 0
    val reports = mutableListOf<NowPlaying?>()
    val published = mutableListOf<List<QueueItem>>()
    val sent = mutableListOf<Pair<Command, String>>()
    var sleepDones = 0

    override fun claim() { claims++ }
    override fun report(np: NowPlaying?) { reports += np }
    override fun publishQueue(queue: List<QueueItem>) { published += queue }
    override fun send(command: Command, to: String) { sent += command to to }
    override fun sleepDone() { sleepDones++ }
    override fun playhead(np: NowPlaying): Double = np.position

    fun edit(f: (SessionState) -> SessionState) { state.value = f(state.value) }
}

class PlayerFakeBackend : PlayerBackend {
    override var token: String? = "tok"
    val library = HashMap<String, Track>()
    val mixes = HashMap<String, List<Track>>()
    val mixCalls = mutableListOf<Triple<String, Int?, String?>>()
    val warms = mutableListOf<List<String>>()
    val plays = mutableListOf<String>()
    var offline = false
    val prewarms = mutableListOf<String>()

    override suspend fun tracks(ids: List<String>) = ids.mapNotNull { library[it] }
    override suspend fun mix(id: String, limit: Int?, mode: String?): Mix {
        mixCalls += Triple(id, limit, mode)
        return Mix(items = mixes[id] ?: emptyList())
    }
    override suspend fun artist(id: String): ArtistDetail = throw ApiError.Http(404, "no")
    override suspend fun warm(ids: List<String>, profile: String, norm: String?) { warms += ids }
    override suspend fun postPlay(trackId: String, at: Double?, client: String) {
        if (offline) throw ApiError.Offline()
        plays += trackId
    }
    override fun hlsUrl(trackId: String, max: String, norm: String?) =
        "http://srv.example.com/api/stream/$trackId/hls/master.m3u8?max=$max" + (norm?.let { "&norm=$it" } ?: "")
    override fun imageUrl(id: String, size: Int) = "http://srv.example.com/api/image/$id?size=$size"
    override suspend fun prewarm(master: String) { prewarms += master }
}

class PlayerFakeLockScreen : NowPlayingPublishing {
    val updates = mutableListOf<LockScreenInfo?>()
    override fun update(info: LockScreenInfo?) { updates += info }
}

class PlayerFakeFocus : AudioFocusControlling {
    override var onInterruptionBegan: (() -> Unit)? = null
    override var onInterruptionEnded: ((Boolean) -> Unit)? = null
    override var onRouteLost: (() -> Unit)? = null
    override val outputLatency = 0.25
    var activations = 0
    var deactivations = 0
    override fun activate() { activations++ }
    override fun deactivate() { deactivations++ }
}

/** Epoch-like base so "older than the saved playhead" reads naturally. */
const val PLAYER_T0 = 1_700_000_000_000.0

class PlayerRig(
    val p: SlopifyPlayer,
    val e: PlayerFakeEngine,
    val l: PlayerFakeLink,
    val b: PlayerFakeBackend,
    val lock: PlayerFakeLockScreen,
    val focus: PlayerFakeFocus,
) {
    val s: PlayerState get() = p.state.value
    val ids: List<String> get() = s.queue.map { it.id }
    val position: Double get() = p.progress.value.position
}

/** Player on virtual time: its jobs run in the test's background scope. */
@OptIn(ExperimentalCoroutinesApi::class)
fun TestScope.makePlayer(prefs: Prefs = emptyMap(), store: PlayerPersistence? = null): PlayerRig {
    val p = SlopifyPlayer(backgroundScope, now = { PLAYER_T0 + testScheduler.currentTime })
    val e = PlayerFakeEngine()
    val l = PlayerFakeLink()
    val b = PlayerFakeBackend()
    val lock = PlayerFakeLockScreen()
    val focus = PlayerFakeFocus()
    p.rng = Random(42)
    p.isTablet = false
    p.headStartMs = 0.0
    p.configure(b, l, { prefs }, e, focus, lock, store)
    return PlayerRig(p, e, l, b, lock, focus)
}

fun playerNp(id: String, index: Int? = null, playing: Boolean = true, position: Double = 10.0) = NowPlaying(
    itemId = id, title = "T$id", artist = "Artist", album = "Album", albumId = "al1", artistId = "ar1",
    artists = listOf(NameId("ar1", "Artist")), liked = false, device = OutputDevice.local("This Computer"),
    queueIndex = index, playing = playing, held = false, position = position, duration = 200.0, volume = 70.0,
    repeat = "all", shuffle = "off", at = 0.0,
)
