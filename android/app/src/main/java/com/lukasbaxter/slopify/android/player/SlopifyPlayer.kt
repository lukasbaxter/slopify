package com.lukasbaxter.slopify.android.player

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.attempt
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.Command
import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.NowPlaying
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.QueueItem
import com.lukasbaxter.slopify.android.core.session.SessionClient
import com.lukasbaxter.slopify.android.core.session.SessionConnection
import com.lukasbaxter.slopify.android.core.session.toTrack
import com.lukasbaxter.slopify.android.core.stores.Likes
import com.lukasbaxter.slopify.android.design.L
import java.io.File
import kotlin.math.abs
import kotlin.properties.ReadWriteProperty
import kotlin.random.Random
import kotlin.reflect.KProperty
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The real [Player]: plays locally through an [AudioEngine] (Media3 in the app) when this
 * device is the output, and mirrors + remote-controls when another device or speaker is
 * active (Commands through the session). The UI never needs to know which.
 *
 * Port of ios/Slopify/Player/Player.swift; behaviour reference web/src/player/usePlayer.js.
 * Pure rules live in [PlayQueue], [StreamPolicy], [SessionReports]. Runs on [scope] (Main).
 */
class SlopifyPlayer(
    private val scope: CoroutineScope,
    /** Epoch ms; tests use virtual time. */
    private val now: () -> Double = { System.currentTimeMillis().toDouble() },
    /** The Android pieces (Media3 engine, focus, media session, storage). Null on the JVM. */
    private val platform: PlayerPlatform? = null,
) : Player, AudioEngineEvents {

    /** What [attach] builds on a device. Tests call [configure] with fakes instead. */
    interface PlayerPlatform {
        fun engine(): AudioEngine
        fun audioFocus(): AudioFocusControlling?
        fun lockScreen(handlers: LockScreenHandlers): NowPlayingPublishing?
        fun linkWatch(): LinkWatch?
        /** Where per-account queue folders live. */
        val storageRoot: File?
        val isTablet: Boolean
        /** Called when the process goes to the background (flush the playhead). */
        fun onBackground(f: () -> Unit)
    }

    // Public state

    private val mutable = MutableStateFlow(PlayerState(output = OutputDevice.local(LOCAL_NAME)))
    private val progressFlow = MutableStateFlow(PlayerProgress())
    override val state: StateFlow<PlayerState> = mutable.asStateFlow()
    override val progress: StateFlow<PlayerProgress> = progressFlow.asStateFlow()

    override var localFile: ((String) -> File?)? = null
    override var likes: Likes? = null
    override var onOfflinePlay: ((String, Double) -> Unit)? = null

    private var queue by ui(emptyList<Track>())
    private var queuedFlags by ui(emptyList<Boolean>())
    private var recFlags by ui(emptyList<Boolean>())
    private var index by ui(0)
    // JvmName: the private setters would clash with Player.setPlaying / setShuffle / setVolume.
    @set:JvmName("uiPlaying") private var isPlaying by ui(false)
    private var isLoading by ui(false)
    private var repeatMode by ui(RepeatMode.Off)
    @set:JvmName("uiShuffle") private var shuffle by ui(ShuffleMode.Off)
    private var context by ui<String?>(null)
    @set:JvmName("uiVolume") private var volume by ui(100.0)
    private var output by ui(OutputDevice.local(LOCAL_NAME))
    private var remoteClientId by ui<String?>(null)
    private var error by ui<String?>(null)
    private var deliveredProfile by ui<DeliveredProfile?>(null)
    private var position = 0.0
        set(v) { if (field != v) { field = v; publishProgress() } }
    private var duration = 0.0
        set(v) { if (field != v) { field = v; publishProgress() } }
    private var progressTick = 0

    private val current: Track? get() = queue.getOrNull(index)

    // Internals

    internal var model = PlayQueue()
        private set
    private var backend: PlayerBackend? = null
    private var link: PlayerSessionLink? = null
    private var prefs: () -> Prefs = { emptyMap() }
    private var engine: AudioEngine? = null
    private var audioFocus: AudioFocusControlling? = null
    private var lockScreen: NowPlayingPublishing? = null
    private var store: PlayerPersistence? = null
    private var linkWatch: LinkWatch? = null
    private var accountKey: String? = null
    var rng: Random = Random.Default
    var isTablet = false
    /** The client string for POST /api/plays. */
    var playClient = "android"
    /** How long the current song plays before the next one is fetched (web: buffer in hand first). */
    var headStartMs = 4000.0
    /** Test hook: the last background job started. */
    internal var lastTask: Job? = null
        private set

    /** Track id the engine holds (null = nothing loaded: restored, yielded, handed off). */
    internal var loadedId: String? = null
        private set
    private var startGen = 0
    private var lastSkipAt = Double.NEGATIVE_INFINITY
    private var heard = false
    private var heardAt = 0.0
    private var wasActiveHere = false
    private var lastSleepEOT = false
    private var preparedNextIndex: Int? = null
    private var prepareTask: Job? = null
    private var warmTask: Job? = null
    private var extendedFor: String? = null
    private var modelVersion = 0
    private var shownVersion = -1
    private var publishedVersion = -1
    private var ticker: Job? = null
    private var lastTickAt = 0.0
    private var lastHeadSave = 0.0
    private var listen = Listen("", 0.0, true, 0.0)
    private var localVolume = 100.0
    private val stepper = VolumeStepper()
    private val likedOverride = HashMap<String, Boolean>()
    private var interruptedWhilePlaying = false
    /** The playhead file's last `at` (ms), compared with a server session (§20.4). */
    internal var savedAt = 0.0
        private set
    private var lastSessionAt: Double? = null
    private var wasMirroring = false
    /** After claiming a take-over, the roster still names the old player for a moment. */
    private var claimPendingUntil = 0.0
    private var mirrorRQ: List<QueueItem>? = null
    private var mirrorItemId: String? = null
    private val trackCache = HashMap<String, Track>()
    private val resolving = HashSet<String>()
    private var queueSaveTask: Job? = null
    private val prewarmedAt = HashMap<String, Double>()
    private var sessionJob: Job? = null
    private var lastLiked: Boolean? = null

    private data class Listen(val id: String, var playedFor: Double, var logged: Boolean, val startedAt: Double)

    // Wiring

    override fun attach(account: Account, session: SessionClient) {
        val p = platform
        isTablet = p?.isTablet ?: false
        playClient = account.deviceName
        configure(
            backend = ApiPlayerBackend(account.api), link = SessionLinkAdapter(session), prefs = { account.prefs.value },
            engine = p?.engine(), audioFocus = p?.audioFocus(), lockScreen = p?.lockScreen(lockScreenHandlers()), store = null,
        )
        linkWatch = p?.linkWatch()
        p?.onBackground { flushPersistence() }
        val root = p?.storageRoot
        scope.launch {
            combine(account.user, account.saved) { u, s -> u?.let { "${s?.main ?: ""}|${it.id}" } }
                .distinctUntilChanged()
                .collect { key -> accountChanged(key, root) }
        }
        likes?.let { l ->
            scope.launch {
                l.state.collect {
                    val id = model.current?.track?.id ?: return@collect
                    val v = liked(id)
                    if (v != lastLiked) { lastLiked = v; reportNow(); updateLockScreen() }
                }
            }
        }
    }

    /** The testable wiring ([attach] builds the real pieces and calls this). */
    fun configure(
        backend: PlayerBackend, link: PlayerSessionLink, prefs: () -> Prefs, engine: AudioEngine?,
        audioFocus: AudioFocusControlling?, lockScreen: NowPlayingPublishing?, store: PlayerPersistence?,
    ) {
        this.backend = backend
        this.link = link
        this.prefs = prefs
        this.engine = engine
        this.audioFocus = audioFocus
        this.lockScreen = lockScreen
        engine?.events = this
        link.onCommand = { cmd, from -> handle(cmd, from) }
        audioFocus?.onInterruptionBegan = { interruptionBegan() }
        audioFocus?.onInterruptionEnded = { resume -> interruptionEnded(resume) }
        audioFocus?.onRouteLost = { routeLost() }
        if (store != null) useStore(store)
        sessionJob?.cancel()
        sessionJob = scope.launch { link.state.collect { sessionChanged() } }
        sessionChanged()
    }

    /** Remote controls for the media session (notification, lock screen, headset buttons). */
    fun lockScreenHandlers() = LockScreenHandlers(
        play = { remoteCommand { setPlaying(true) } },
        pause = { remoteCommand { setPlaying(false) } },
        next = { remoteCommand { next() } },
        previous = { remoteCommand { previous() } },
        seek = { s -> remoteCommand { seek(s) } },
        skipTo = { i -> remoteCommand { skipTo(i) } },
        like = { want -> likeFromLockScreen(want) },
        position = { positionNow() },
    )

    // Surface

    override fun clearError() { error = null }

    override fun outputLag(): Double {
        if (mirrorTarget != null || loadedId == null || !isPlaying) return 0.0
        val v = audioFocus?.outputLatency ?: 0.0
        return if (v.isFinite()) v.coerceIn(0.0, 2.0) else 0.0
    }

    /** Touch-down on a row (TrackRow.jsx `jf.prewarm`): HLS only, once a minute per song. */
    override fun prewarm(track: Track) {
        val backend = backend ?: return
        if (mirrorTarget != null || localFile?.invoke(track.id) != null) return
        val t = now()
        prewarmedAt[track.id]?.let { if (t - it < 60_000) return }
        prewarmedAt[track.id] = t
        if (prewarmedAt.size > 200) prewarmedAt.entries.removeAll { t - it.value >= 60_000 }
        val norm = StreamPolicy.normMode(track, model.context, StreamPolicy.normalize(prefs()))
        val master = backend.hlsUrl(track.id, profile, norm)
        scope.launch { attempt { backend.prewarm(master) } }
    }

    override fun positionNow(): Double {
        val np = mirroredNowPlaying
        val link = link
        if (np != null && link != null) return clampPos(link.playhead(np), np.duration)
        val e = engine
        if (e != null && loadedId != null && loadedId == model.current?.track?.id) return e.currentTime
        return position
    }

    // Starting playback

    override fun play(tracks: List<Track>, startAt: Int, context: String?, shuffle: Boolean?) {
        if (tracks.isEmpty()) return
        val i = if (startAt in tracks.indices) startAt else 0
        mirrorTarget?.let { target ->
            if (shuffle != null) link?.send(Command.SetShuffle(if (shuffle) ShuffleMode.On.wire else ShuffleMode.Off.wire), target)
            link?.send(Command.Play(tracks.map { it.id }, i, context, null), target)
            return
        }
        if (shuffle != null) model.shuffle = if (shuffle) ShuffleMode.On else ShuffleMode.Off
        localPlay(tracks, i, context, 0.0)
    }

    override fun playNext(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        // The protocol has no "play next": the closest command is enqueue.
        mirrorTarget?.let { link?.send(Command.Enqueue(tracks.map { t -> t.id }), it); return }
        mutate { it.insertNext(tracks) }
        afterQueueEdit()
    }

    override fun addToQueue(tracks: List<Track>) {
        if (tracks.isEmpty()) return
        mirrorTarget?.let { link?.send(Command.Enqueue(tracks.map { t -> t.id }), it); return }
        localAdd(tracks)
    }

    /** Radio from a track/artist/album/playlist id (API.md §14). */
    override suspend fun startRadio(seedId: String, context: String?) {
        val backend = backend ?: return
        try {
            val items = StreamPolicy.dropDisliked(backend.mix(seedId, 100, "radio").items, prefs())
            if (items.isEmpty()) return
            play(items, 0, context, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        }
    }

    // Transport

    override fun togglePlay() {
        mirrorTarget?.let { target ->
            // Ask for the opposite of what is shown, never a flip (web toggle).
            val np = mirroredNowPlaying
            link?.send(if (np != null) Command.SetPlaying(!np.playing) else Command.Toggle, target)
            return
        }
        localSetPlaying(!isPlaying)
    }

    override fun setPlaying(playing: Boolean) {
        mirrorTarget?.let { link?.send(Command.SetPlaying(playing), it); return }
        if (isPlaying != playing) localSetPlaying(playing)
    }

    override fun next() {
        mirrorTarget?.let { link?.send(Command.Next, it); return }
        advance(auto = false)
    }

    override fun previous() {
        mirrorTarget?.let { link?.send(Command.Previous, it); return }
        localPrevious()
    }

    override fun seek(seconds: Double) {
        mirrorTarget?.let {
            link?.send(Command.Seek(seconds), it)
            position = seconds
            return
        }
        localSeek(seconds)
    }

    override fun skipTo(index: Int) {
        mirrorTarget?.let { link?.send(Command.SkipTo(index), it); return }
        skipLocal(index, debounce = true)
    }

    override fun setRepeat(mode: RepeatMode) {
        mirrorTarget?.let { link?.send(Command.SetRepeat(mode.wire), it); return }
        localSetRepeat(mode)
    }

    override fun setShuffle(mode: ShuffleMode) {
        mirrorTarget?.let { link?.send(Command.SetShuffle(mode.wire), it); return }
        localSetShuffle(mode)
    }

    override fun setVolume(level: Double) {
        val l = level.coerceIn(0.0, 100.0)
        mirrorTarget?.let { volume = l; link?.send(Command.SetVolume(l), it); return }
        localSetVolume(l)
    }

    // Queue editing

    override fun removeFromQueue(index: Int) {
        mirrorTarget?.let { link?.send(Command.QueueRemove(index), it); return }
        if (mutate { it.remove(index) }) afterQueueEdit()
    }

    override fun moveInQueue(from: Int, to: Int) {
        mirrorTarget?.let { link?.send(Command.QueueMove(from, to), it); return }
        if (mutate { it.move(from, to) }) afterQueueEdit()
    }

    override fun clearQueued() {
        mirrorTarget?.let { link?.send(Command.QueueClear, it); return }
        mutate { it.clearQueued() }
        afterQueueEdit()
    }

    // Output

    override fun transferToClient(clientId: String?) {
        if (clientId != null && clientId != link?.state?.value?.clientId) handOff(clientId, "local") else takeOverHere()
    }

    override fun transferToSpeaker(device: LanDevice) {
        val via = device.viaClient ?: link?.state?.value?.players?.firstOrNull { it.isServer }?.id ?: return
        handOff(via, device.id)
    }

    // Mirror (another client is active)

    /** Who controls go to: the active client, when it is another one. */
    private val mirrorTarget: String?
        get() {
            val s = link?.state?.value ?: return null
            val id = s.activeClientId ?: return null
            if (id == s.clientId || now() < claimPendingUntil || s.players.none { it.id == id }) return null
            return id
        }

    private val mirroredNowPlaying: NowPlaying?
        get() {
            val id = mirrorTarget ?: return null
            return link?.state?.value?.players?.firstOrNull { it.id == id }?.nowPlaying
        }

    /** Roster / queues / session snapshot changed. */
    internal fun sessionChanged() {
        val link = link ?: return
        val s = link.state.value
        val target = mirrorTarget
        if (target != null) {
            if (remoteClientId == null) enterMirror()
            syncMirror(target)
        } else if (remoteClientId != null) {
            leaveMirror()
        }
        val activeHere = s.activeClientId != null && s.activeClientId == s.clientId
        if (activeHere) claimPendingUntil = 0.0
        if (activeHere && !wasActiveHere) {
            // Just became the active player: everyone needs our state and queue now.
            publishedVersion = -1
            reportNow(); publishQueueIfNeeded()
        }
        wasActiveHere = activeHere
        val snap = s.lastSession
        if (s.activeClientId == null && snap != null && snap.at != lastSessionAt) {
            lastSessionAt = snap.at
            adoptSession(snap.nowPlaying, snap.queue, snap.at)
        }
        val eot = s.sleep?.endOfTrack == true
        if (eot != lastSleepEOT) { lastSleepEOT = eot; prepareNext() }
    }

    private fun enterMirror() {
        wasMirroring = true
        localVolume = volume
        // Not the sound source: the lock screen belongs to whoever plays (yield unloads us).
        if (loadedId == null || !isPlaying) lockScreen?.update(null)
    }

    private fun leaveMirror() {
        remoteClientId = null
        mirrorRQ = null; mirrorItemId = null
        output = OutputDevice.local(if (output.id == "local") output.name else LOCAL_NAME)
        shownVersion = -1
        showLocal()
        isPlaying = loadedId != null && isPlaying
        isLoading = false
        volume = localVolume
        position = if (loadedId != null) positionNow() else position
        duration = model.current?.track?.duration ?: 0.0
        updateLockScreen()
        updateTicker()
    }

    private fun syncMirror(target: String) {
        val link = link ?: return
        val s = link.state.value
        val p = s.players.firstOrNull { it.id == target } ?: return
        if (remoteClientId != target) remoteClientId = target
        val np = p.nowPlaying
        val dev = np?.device?.takeIf { it.id != "local" } ?: OutputDevice(id = target, kind = p.kind ?: "client", name = p.name)
        if (output != dev) output = dev
        val rq = s.queues[target] ?: emptyList()
        if (np != null) {
            if (rq != mirrorRQ || np.itemId != mirrorItemId) rebuildMirrorQueue(np, rq)
            isPlaying = np.playing
            isLoading = np.held ?: false
            position = clampPos(link.playhead(np), np.duration)
            duration = np.duration ?: current?.duration ?: 0.0
            np.volume?.let { volume = it }
            np.repeat?.let { r -> RepeatMode.entries.firstOrNull { it.wire == r }?.let { repeatMode = it } }
            np.shuffle?.let { r -> ShuffleMode.entries.firstOrNull { it.wire == r }?.let { shuffle = it } }
        } else {
            mirrorRQ = null; mirrorItemId = null
            if (queue.isNotEmpty()) { queue = emptyList(); queuedFlags = emptyList(); recFlags = emptyList() }
            index = 0; isPlaying = false; isLoading = false; position = 0.0; duration = 0.0
        }
        updateTicker()
    }

    private fun rebuildMirrorQueue(np: NowPlaying, rq: List<QueueItem>) {
        mirrorRQ = rq; mirrorItemId = np.itemId
        var tracks = rq.map { trackCache[it.id] ?: it.toTrack() }
        var flags = rq.map { it.queued ?: false }
        var i = SessionReports.queueIndex(np, rq) ?: rq.indexOfFirst { it.id == np.itemId }
        if (i < 0) { tracks = listOf(trackCache[np.itemId] ?: np.toTrack()); flags = listOf(false); i = 0 }
        if (tracks != queue) { queue = tracks; queuedFlags = flags; recFlags = flags.map { false } }
        index = i
        resolve(tracks.drop(maxOf(0, i - 50)).take(250).map { it.id })
    }

    /** Fill provisional (socket) tracks with full records, cached (§20.6 mirrors). */
    private fun resolve(ids: List<String>) {
        val backend = backend ?: return
        val missing = ids.filter { it !in trackCache && it !in resolving }
        if (missing.isEmpty()) return
        resolving += missing
        lastTask = scope.launch {
            val got = attempt { backend.tracks(missing) } ?: emptyList()
            resolving -= missing.toSet()
            for (t in got) trackCache[t.id] = t
            if (got.isEmpty()) return@launch
            val target = mirrorTarget
            val np = mirroredNowPlaying
            if (target != null && np != null) {
                rebuildMirrorQueue(np, link?.state?.value?.queues?.get(target) ?: emptyList())
            } else {
                val byId = got.associateBy { it.id }
                mutate { q ->
                    q.entries = q.entries.map { e -> byId[e.track.id]?.let { e.copy(track = it) } ?: e }
                    q.original = q.original.map { e -> byId[e.track.id]?.let { e.copy(track = it) } ?: e }
                }
                showLocal()
                updateLockScreen()
            }
        }
    }

    /**
     * The server's remembered session (§20.4 `session`): adopt it paused unless this device
     * plays, has something loaded, or remembers a newer playhead (web `applySession`).
     */
    private fun adoptSession(np: NowPlaying, items: List<QueueItem>, at: Double) {
        if (np.itemId.isEmpty()) return
        if (!model.isEmpty && isPlaying && loadedId != null) return
        if (!wasMirroring) {
            if (!model.isEmpty && loadedId != null) return
            if (!model.isEmpty && savedAt >= at) return
        }
        var rows = items.map { QueueEntry(trackCache[it.id] ?: it.toTrack(), queued = it.queued ?: false) }
        var i = SessionReports.queueIndex(np, items) ?: items.indexOfFirst { it.id == np.itemId }
        if (i < 0) { rows = listOf(QueueEntry(np.toTrack())); i = 0 }
        mutate { q ->
            q.adopt(rows, i, context = null)
            np.repeat?.let { r -> RepeatMode.entries.firstOrNull { it.wire == r }?.let { q.repeatMode = it } }
            np.shuffle?.let { r -> ShuffleMode.entries.firstOrNull { it.wire == r }?.let { q.shuffle = it } }
        }
        wasMirroring = false
        unloadEngine()
        showLocal()
        val dur = model.current?.track?.duration ?: 0.0
        isPlaying = false; isLoading = false
        position = clampPos(np.position, if (dur > 0) dur else null)
        duration = dur
        persistQueue(); persistPlayhead(force = true)
        updateLockScreen()
        resolve(rows.drop(maxOf(0, i - 50)).take(250).map { it.track.id })
    }

    // Transfer (§20.6)

    private fun handOff(target: String, deviceId: String) {
        val link = link ?: return
        val active = mirrorTarget
        val np = mirroredNowPlaying
        val payload = if (active != null && np != null) {
            if (active == target && deviceId == "local") return
            val t = SessionReports.takeOver(np, link.state.value.queues[active] ?: emptyList())
            Command.TransferPayload(t.ids, t.queued, t.index, link.playhead(np), np.playing, null, null, deviceId)
        } else {
            if (model.current == null) return
            model.transfer(positionNow(), isPlaying, deviceId)
        }
        link.send(Command.Transfer(payload), target)
        if (mirrorTarget == null) stopForHandOff()
    }

    /** Our audio stops at once so two devices never overlap (we also get `yield`). */
    private fun stopForHandOff() {
        val pos = positionNow()
        unloadEngine()
        startGen++
        isPlaying = false; isLoading = false
        position = pos
        persistPlayhead(force = true)
        lockScreen?.update(null)
        audioFocus?.deactivate()
        updateTicker()
    }

    /** "Play here": claim, take the active's queue, start at its extrapolated playhead. */
    private fun takeOverHere() {
        val link = link
        val active = mirrorTarget
        if (link == null || active == null) {
            if (model.current != null && !isPlaying) localSetPlaying(true)
            return
        }
        val np = mirroredNowPlaying
        val rq = link.state.value.queues[active] ?: emptyList()
        link.claim()
        claimPendingUntil = now() + 5000
        if (np == null) { leaveMirror(); return }
        val t = SessionReports.takeOver(np, rq)
        val rows = if (t.ids.size == rq.size && rq.isNotEmpty()) {
            rq.map { QueueEntry(trackCache[it.id] ?: it.toTrack(), queued = it.queued ?: false) }
        } else {
            listOf(QueueEntry(trackCache[np.itemId] ?: np.toTrack()))
        }
        val from = link.playhead(np)
        leaveMirror()
        mutate { q ->
            q.adopt(rows, t.index, context = null)
            np.repeat?.let { r -> RepeatMode.entries.firstOrNull { it.wire == r }?.let { q.repeatMode = it } }
            np.shuffle?.let { r -> ShuffleMode.entries.firstOrNull { it.wire == r }?.let { q.shuffle = it } }
        }
        error = null
        startLocal(model.index, from, play = true)
        resolve(rows.drop(maxOf(0, t.index - 50)).take(250).map { it.track.id })
    }

    // Commands (§20.5), executed here as the active player

    internal fun handle(command: Command, from: String) {
        when (command) {
            is Command.Play -> {
                val ids = command.trackIds
                if (ids.isEmpty()) return
                val chosen = ids[command.index.coerceIn(0, ids.size - 1)]
                lastTask = scope.launch {
                    val first = fetch(listOf(chosen)).firstOrNull() ?: return@launch
                    localPlay(listOf(first), 0, command.ctx, command.startAt ?: 0.0)
                    if (ids.size <= 1) return@launch
                    val all = fetch(ids)
                    if (model.current?.track?.id != chosen || all.isEmpty()) return@launch
                    val at = maxOf(0, all.indexOfFirst { it.id == chosen })
                    mutate { it.start(all, at, command.ctx, rng) }
                    afterQueueEdit()
                }
            }
            is Command.Transfer -> receiveTransfer(command.transfer)
            is Command.Enqueue -> lastTask = scope.launch {
                val tracks = fetch(command.trackIds)
                if (tracks.isNotEmpty()) localAdd(tracks)
            }
            is Command.QueueRemove -> if (mutate { it.remove(command.index) }) afterQueueEdit()
            is Command.QueueMove -> if (mutate { it.move(command.from, command.to) }) afterQueueEdit()
            Command.QueueClear -> { mutate { it.clearQueued() }; afterQueueEdit() }
            is Command.SkipTo -> skipLocal(command.index, debounce = true)
            Command.Toggle -> localSetPlaying(!isPlaying)
            is Command.SetPlaying -> if (isPlaying != command.playing) localSetPlaying(command.playing)
            is Command.Seek -> localSeek(command.pos)
            is Command.SetVolume -> localSetVolume(command.level.coerceIn(0.0, 100.0))
            is Command.VolumeStep -> stepper.step(Math.round(volume).toDouble(), command.step, now())?.let { localSetVolume(it) }
            Command.Next -> advance(auto = false)
            Command.Previous -> localPrevious()
            is Command.SetRepeat -> localSetRepeat(RepeatMode.of(command.mode))
            is Command.SetShuffle -> localSetShuffle(ShuffleMode.of(command.mode))
            is Command.PatchLiked -> {
                likedOverride[command.itemId] = command.liked
                reportNow(); updateLockScreen()
            }
            Command.Yield -> yieldHere()
            is Command.Unknown -> Unit
        }
    }

    /**
     * Another client handed the session to us: claim, start the chosen song from its own
     * record, fill in the queue behind it (web executeCommand 'transfer').
     */
    private fun receiveTransfer(t: Command.TransferPayload) {
        if (t.trackIds.isEmpty()) return
        link?.claim()
        claimPendingUntil = now() + 5000
        // This phone drives no speakers itself: a speaker id here still plays on this phone.
        val chosen = t.trackIds[t.index.coerceIn(0, t.trackIds.size - 1)]
        if (remoteClientId != null) leaveMirror()
        lastTask = scope.launch {
            val first = fetch(listOf(chosen)).firstOrNull()
            if (first == null) {
                error = L("Could not take over playback: {error}", "error" to "track not found")
                return@launch
            }
            mutate { it.adopt(listOf(QueueEntry(first)), 0, context = t.ctx) }
            error = null
            startLocal(0, t.position, play = t.playing)
            if (t.trackIds.size <= 1) return@launch
            val all = fetch(t.trackIds)
            if (model.current?.track?.id != chosen || all.isEmpty()) return@launch
            val rows = PlayQueue.marked(all, t.trackIds, t.queued)
            val at = maxOf(0, rows.indexOfFirst { it.track.id == chosen })
            val byId = all.associateBy { it.id }
            val orig = t.original?.mapNotNull { byId[it] }?.map { QueueEntry(it) }
            mutate { it.adopt(rows, at, orig, t.ctx) }
            afterQueueEdit()
        }
    }

    /** Another client took over: stop and unload, become a mirror (web `yieldRef`). */
    private fun yieldHere() {
        val pos = positionNow()
        unloadEngine()
        startGen++
        claimPendingUntil = 0.0
        isPlaying = false; isLoading = false
        position = pos
        persistPlayhead(force = true)
        lockScreen?.update(null)
        audioFocus?.deactivate()
        updateTicker()
        sessionChanged()
    }

    private suspend fun fetch(ids: List<String>): List<Track> {
        val missing = ids.filter { it !in trackCache }
        val backend = backend
        if (missing.isNotEmpty() && backend != null) {
            attempt { backend.tracks(missing) }?.forEach { trackCache[it.id] = it }
        }
        return ids.mapNotNull { trackCache[it] }
    }

    // Local playback

    private fun localPlay(tracks: List<Track>, i: Int, ctx: String?, startAt: Double) {
        link?.claim()
        error = null
        mutate { it.start(tracks, i, ctx, rng) }
        startLocal(model.index, maxOf(0.0, startAt), play = true)
    }

    private fun localAdd(tracks: List<Track>) {
        val wasEmpty = mutate { it.add(tracks) }
        if (wasEmpty) {
            unloadEngine()
            showLocal()
            isPlaying = false; isLoading = false; position = 0.0
            duration = model.current?.track?.duration ?: 0.0
            updateLockScreen()
        }
        afterQueueEdit()
    }

    /**
     * Start entry `i` (web startOn via skipTo / playQueue). `play = false` shows it paused,
     * nothing loaded (a paused hand-over).
     */
    private fun startLocal(i: Int, pos: Double, play: Boolean, debounce: Boolean = false) {
        if (i !in model.entries.indices) return
        model.index = i
        val track = model.entries[i].track
        startGen++
        val gen = startGen
        heard = false
        preparedNextIndex = null
        prepareTask?.cancel(); warmTask?.cancel()
        showLocal()
        position = pos
        duration = track.duration
        isPlaying = play
        isLoading = play
        newListen(track.id)
        if (play) {
            val t = now()
            val rapid = debounce && t - lastSkipAt < 300
            lastSkipAt = t
            if (rapid) {
                // Hunting through the queue: one start after the taps stop, not ten.
                lastTask = scope.launch {
                    delay(300)
                    load(track, pos, gen)
                }
            } else {
                load(track, pos, gen)
            }
        } else {
            unloadEngine()
        }
        reportNow()
        updateLockScreen()
        persistPlayhead(force = true)
        publishQueueIfNeeded()
        extendEarly()
        updateTicker()
    }

    private fun load(track: Track, pos: Double, gen: Int) {
        val engine = engine
        if (gen != startGen || engine == null) return
        audioFocus?.activate()
        engine.setVolume((localVolumeNow / 100).toFloat())
        val item = audioItem(track)
        engine.load(item, pos, play = true)
        loadedId = track.id
        deliveredProfile = delivered(item)
        prepareNext()
    }

    private fun unloadEngine() {
        engine?.unload(); loadedId = null; deliveredProfile = null
    }

    private val localVolumeNow: Double get() = if (remoteClientId == null) volume else localVolume

    /** web `skipTo`: past the end parks on the last song at 0:00, paused. */
    private fun skipLocal(i: Int, debounce: Boolean = false) {
        if (model.isEmpty) return
        if (i >= model.entries.size) {
            unloadEngine()
            startGen++
            model.index = model.entries.size - 1
            parkHere()
            return
        }
        startLocal(maxOf(0, i), 0.0, play = true, debounce = debounce)
    }

    /** Shown paused at the top of the current song, nothing loaded. */
    private fun parkHere() {
        showLocal()
        isPlaying = false; isLoading = false; position = 0.0
        duration = model.current?.track?.duration ?: 0.0
        reportNow(); updateLockScreen(); persistPlayhead(force = true); updateTicker()
    }

    private fun localSetPlaying(want: Boolean) {
        val cur = model.current ?: return
        if (want) {
            link?.claim()
            if (loadedId != cur.track.id || engine?.currentId != cur.track.id) {
                // Restored, yielded or dead: load it here at the remembered playhead.
                startLocal(model.index, position, play = true)
                return
            }
            audioFocus?.activate()
            engine?.play()
            isPlaying = true
            isLoading = !heard
        } else {
            engine?.pause()
            position = positionNow()
            isPlaying = false
            isLoading = false
            persistPlayhead(force = true)
        }
        reportNow(); updateLockScreen(); updateTicker()
    }

    private fun localPrevious() {
        when (val a = model.previous(positionNow())) {
            is Advance.Skip -> skipLocal(a.index, debounce = true)
            else -> {
                // Same song: rewind in place when it is loaded (web), else start it.
                val cur = model.current
                if (cur != null && loadedId == cur.track.id) {
                    engine?.seek(0.0)
                    position = 0.0
                    isLoading = isPlaying
                    newListen(cur.track.id)
                    reportNow(); updateLockScreen()
                } else {
                    skipLocal(model.index)
                }
            }
        }
    }

    private fun localSeek(s: Double) {
        val cur = model.current ?: return
        val target = clampPos(s, if (cur.track.duration > 0) cur.track.duration else null)
        position = target
        if (loadedId == cur.track.id) {
            engine?.seek(target)
            isLoading = isPlaying
        }
        reportNow(); updateLockScreen(); persistPlayhead(force = true)
    }

    private fun localSetVolume(l: Double) {
        volume = l
        localVolume = l
        engine?.setVolume((l / 100).toFloat())
        reportNow()
    }

    private fun localSetRepeat(mode: RepeatMode) {
        mutate { it.repeatMode = mode }
        repeatMode = mode
        prepareNext(); reportNow(); persistPlayhead(force = true)
        extendEarly()
    }

    private fun localSetShuffle(mode: ShuffleMode) {
        val was = model.shuffle
        mutate { it.setShuffle(mode, rng) }
        afterQueueEdit()
        if (mode == ShuffleMode.Smart && was != ShuffleMode.Smart) blendSmart()
    }

    /** web `advance`. */
    private fun advance(auto: Boolean) {
        if (model.isEmpty) return
        when (val a = model.advance(auto, sleepEndOfTrack = link?.state?.value?.sleep?.endOfTrack == true)) {
            is Advance.Skip -> skipLocal(a.index, debounce = !auto)
            Advance.Replay -> startLocal(model.index, 0.0, play = true)
            Advance.Restart -> {
                mutate { it.restartOrder(rng) }
                publishQueueIfNeeded()
                startLocal(0, 0.0, play = true)
            }
            is Advance.MoreOfArtist -> moreOfArtist(a.artistId)
            is Advance.Autoplay -> autoplay(a.orRestart)
            is Advance.SleepStop -> {
                unloadEngine()
                startGen++
                model.index = a.index
                link?.sleepDone()
                parkHere()
            }
        }
    }

    /** web `smartNext`: similar songs appended; none -> start over (with a context) or park. */
    private fun autoplay(orRestart: Boolean) {
        val backend = backend ?: return
        val cur = model.current ?: return
        val gen = startGen
        val mode = if (model.shuffle == ShuffleMode.Smart) "smart" else "continue"
        lastTask = scope.launch {
            val fresh = attempt { backend.mix(cur.track.id, 25, mode).items } ?: emptyList()
            if (gen != startGen) return@launch
            val pick = StreamPolicy.dropDisliked(fresh, prefs())
            val n = mutate { it.appendAutoplay(pick, cur.track.id, fallbackAllowNonSeed = true, rng = rng) }
            if (n > 0) { publishQueueIfNeeded(); skipLocal(model.index + 1) } else skipLocal(if (orRestart) 0 else model.entries.size)
        }
    }

    /** web `moreOfArtist`: everything by them not queued yet, shuffled; then a mix; then start over. */
    private fun moreOfArtist(artistId: String) {
        val backend = backend ?: return
        val gen = startGen
        lastTask = scope.launch {
            val have = model.entries.mapTo(HashSet()) { it.track.id }
            var pick = (attempt { backend.artist(artistId).tracks } ?: emptyList()).filter { it.id !in have }
            pick = StreamPolicy.dropDisliked(pick, prefs()).shuffled(rng)
            if (pick.isEmpty()) {
                pick = StreamPolicy.dropDisliked(attempt { backend.mix(artistId, 25, null).items } ?: emptyList(), prefs())
                    .filter { it.id !in have }
            }
            if (gen != startGen) return@launch
            if (pick.isEmpty() || mutate { it.appendMore(pick) } == 0) {
                mutate { it.restartOrder(rng) }
                startLocal(0, 0.0, play = true)
            } else {
                publishQueueIfNeeded()
                skipLocal(model.index + 1)
            }
        }
    }

    /** Two songs before the end, the autoplay songs are appended so they preload (web "queue extended early"). */
    private fun extendEarly() {
        val backend = backend ?: return
        if (mirrorTarget != null || !model.wantsEarlyExtension(remoteActive = false)) return
        val last = model.entries.lastOrNull()?.track ?: return
        if (extendedFor == last.id) return
        extendedFor = last.id
        val mode = if (model.shuffle == ShuffleMode.Smart) "smart" else "continue"
        lastTask = scope.launch {
            try {
                val fresh = backend.mix(last.id, 25, mode).items
                if (model.entries.lastOrNull()?.track?.id != last.id) return@launch
                val pick = StreamPolicy.dropDisliked(fresh, prefs())
                if (mutate { it.appendAutoplay(pick, last.id, rng = rng) } > 0) afterQueueEdit()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                extendedFor = null
            }
        }
    }

    /** web `blendSmart`. */
    private fun blendSmart() {
        val backend = backend ?: return
        val cur = model.current ?: return
        if (model.entries.size - model.index < 4) return
        val want = model.smartWant
        val version = modelVersion
        lastTask = scope.launch {
            val recs = attempt { backend.mix(cur.track.id, want + 1, "smart").items } ?: return@launch
            if (model.shuffle != ShuffleMode.Smart || modelVersion != version || model.current?.track?.id != cur.track.id) return@launch
            val picks = StreamPolicy.dropDisliked(recs, prefs()).take(want)
            if (mutate { it.blendSmart(picks) } > 0) afterQueueEdit()
        }
    }

    private fun afterQueueEdit() {
        showLocal()
        prepareNext()
        publishQueueIfNeeded()
        persistQueue()
        reportNow()
        updateLockScreen()
        extendEarly()
    }

    // Streams

    private val quality: String get() = StreamPolicy.quality(prefs(), isTablet)

    private val profile: String
        get() {
            val p = StreamPolicy.profile(quality)
            return linkWatch?.profile(p) ?: p
        }

    internal fun audioItem(track: Track): AudioItem {
        val norm = StreamPolicy.normalize(prefs())
        val mode = StreamPolicy.normMode(track, model.context, norm)
        localFile?.invoke(track.id)?.let { file ->
            val p = if (quality == "original") "alac" else "aac"
            return AudioItem(track.id, file.toURI().toString(), StreamPolicy.clientGain(track, model.context, norm, p), track.duration)
        }
        val p = profile
        val url = backend?.hlsUrl(track.id, p, mode) ?: ""
        return AudioItem(track.id, url, StreamPolicy.clientGain(track, model.context, norm, p), track.duration)
    }

    /**
     * Give the engine what follows the current song, after this one has a head start on the
     * network (web: next songs wait until the current one has buffer in hand).
     */
    private fun prepareNext() {
        prepareTask?.cancel(); prepareTask = null
        val engine = engine ?: return
        val cur = model.current
        val ni = model.upcomingIndex
        if (mirrorTarget != null || cur == null || loadedId != cur.track.id || ni == null || link?.state?.value?.sleep?.endOfTrack == true) {
            preparedNextIndex = null
            engine.setNext(null, AudioTransition.None)
            return
        }
        val next = model.entries[ni].track
        val tr = if (ni == model.index) {
            AudioTransition.Gapless // repeat one: the same song again, seamless
        } else {
            val p = prefs()
            StreamPolicy.transition(
                cur.track, next, model.context, StreamPolicy.crossfadeSetting(p), StreamPolicy.gapless(p),
                repeatOne = false, sleepEndOfTrack = false,
            )
        }
        val item = audioItem(next)
        val id = cur.track.id
        val apply = {
            if (model.current?.track?.id == id && loadedId == id) {
                preparedNextIndex = ni
                this.engine?.setNext(item, tr)
            }
        }
        if (heard && now() - heardAt >= headStartMs) { apply(); return }
        prepareTask = scope.launch {
            while (isActive && (!heard || now() - heardAt < headStartMs)) delay(250)
            if (isActive) apply()
        }
    }

    /** §12.4: the next songs transcoded server-side, a few seconds after this one sounds. */
    private fun warmAhead() {
        warmTask?.cancel()
        val backend = backend ?: return
        val cur = model.current ?: return
        val id = cur.track.id
        warmTask = scope.launch {
            delay(3000)
            if (model.current?.track?.id != id || !isPlaying) return@launch
            val ids = StreamPolicy.warmIds(model.entries, model.index, model.repeatMode == RepeatMode.All)
            if (ids.isEmpty()) return@launch
            val nextTrack = model.upcoming?.track ?: cur.track
            val norm = StreamPolicy.normMode(nextTrack, model.context, StreamPolicy.normalize(prefs()))
            attempt { backend.warm(ids, profile, norm) }
        }
    }

    // Reports (§20.5, §15.1)

    private fun isReporter(): Boolean {
        val s = link?.state?.value ?: return false
        if (mirrorTarget != null) return false
        return loadedId != null || isPlaying || s.activeClientId == s.clientId
    }

    private fun liked(id: String): Boolean = likedOverride[id] ?: likes?.isLiked(id) ?: false

    private fun reportNow() {
        val link = link ?: return
        if (!isReporter()) return
        val cur = model.current?.track
        if (cur == null) { link.report(null); return }
        link.report(
            SessionReports.nowPlaying(
                SessionReports.LocalState(
                    track = cur, index = model.index, playing = isPlaying, held = isLoading, position = positionNow(),
                    duration = if (duration > 0) duration else cur.duration, volume = volume, repeatMode = model.repeatMode,
                    shuffle = model.shuffle, liked = liked(cur.id),
                    device = OutputDevice.local(if (output.id == "local" && output.name.isNotEmpty()) output.name else LOCAL_NAME),
                    artUrl = artUrl(cur.id), now = now(),
                ),
            ),
        )
    }

    private fun artUrl(id: String): String? {
        val backend = backend ?: return null
        val base = backend.imageUrl(id, 128)
        val token = backend.token ?: return base
        return base + (if ('?' in base) "&" else "?") + "token=" + java.net.URLEncoder.encode(token, "UTF-8")
    }

    private fun publishQueueIfNeeded() {
        val link = link ?: return
        if (!isReporter() || publishedVersion == modelVersion) return
        publishedVersion = modelVersion
        link.publishQueue(model.entries.map { QueueItem.of(it.track, queued = it.queued, liked = liked(it.track.id)) })
    }

    private fun newListen(id: String) {
        listen = Listen(id, 0.0, false, now())
    }

    /** The server logs a play after 8 s of `playing` reports. Without a socket we POST it. */
    internal fun countListen(dt: Double) {
        if (!isPlaying || isLoading || listen.logged || listen.id != loadedId) return
        listen.playedFor += dt
        if (listen.playedFor < 8) return
        listen.logged = true
        if (link?.state?.value?.connection == SessionConnection.Connected) return
        val backend = backend ?: return
        val id = listen.id
        val at = listen.startedAt
        val client = playClient
        lastTask = scope.launch {
            try {
                backend.postPlay(id, at, client)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ApiError.Offline) {
                onOfflinePlay?.invoke(id, at)
            } catch (_: Exception) {
            }
        }
    }

    // Lock screen

    private fun updateLockScreen() {
        val lockScreen = lockScreen ?: return
        val cur = model.current?.track
        if (mirrorTarget != null || cur == null) { lockScreen.update(null); return }
        lockScreen.update(
            LockScreenInfo(
                id = cur.id, title = cur.title, artist = cur.creditLine, album = cur.album,
                duration = if (duration > 0) duration else cur.duration, elapsed = positionNow(), playing = isPlaying, loading = isLoading,
                loaded = loadedId != null, index = model.index, queue = queue, liked = liked(cur.id),
                artUrl = backend?.let { artUrl(cur.id)?.replace("size=128", "size=640") },
            ),
        )
    }

    private fun likeFromLockScreen(want: Boolean): Boolean {
        val id = current?.id ?: return false
        val likes = likes ?: return false
        if (likes.isLiked(id) != want) scope.launch { attempt { likes.set(id, liked = want) } }
        mirrorTarget?.let { link?.send(Command.PatchLiked(id, want), it) }
        likedOverride[id] = want
        reportNow(); updateLockScreen()
        return true
    }

    private inline fun remoteCommand(f: () -> Unit): Boolean {
        if (current == null && model.current == null) return false
        f()
        return true
    }

    // Audio focus events

    private fun interruptionBegan() {
        if (mirrorTarget != null || !isPlaying) return
        interruptedWhilePlaying = true
        engine?.pause()
        position = positionNow()
        isPlaying = false; isLoading = false
        reportNow(); updateLockScreen(); persistPlayhead(force = true); updateTicker()
    }

    private fun interruptionEnded(shouldResume: Boolean) {
        val resume = interruptedWhilePlaying && shouldResume
        interruptedWhilePlaying = false
        if (resume && mirrorTarget == null && loadedId != null) localSetPlaying(true)
    }

    private fun routeLost() {
        if (mirrorTarget != null || !isPlaying) return
        interruptedWhilePlaying = false
        localSetPlaying(false)
    }

    // Ticker

    private fun updateTicker() {
        if (isPlaying) {
            if (ticker != null) return
            lastTickAt = now()
            ticker = scope.launch {
                while (isActive) {
                    delay(500)
                    tick()
                }
            }
        } else {
            ticker?.cancel(); ticker = null
            progressTick++
            publishProgress()
        }
    }

    internal fun tick() {
        val t = now()
        val dt = ((t - lastTickAt) / 1000).coerceIn(0.0, 2.0)
        lastTickAt = t
        val p = positionNow()
        if (abs(p - position) > 0.01) position = p
        progressTick++
        publishProgress()
        if (mirrorTarget == null) {
            countListen(dt)
            if (t - lastHeadSave > 5000) persistPlayhead(force = false)
        }
    }

    // Persistence

    private fun accountChanged(key: String?, root: File?) {
        if (key == accountKey) return
        accountKey = key
        if (key != null) {
            if (root != null) useStore(PlayerPersistence.forAccount(root, key))
        } else {
            signedOut()
        }
    }

    private fun signedOut() {
        unloadEngine()
        startGen++
        store = null
        model = PlayQueue(); modelVersion++
        trackCache.clear(); likedOverride.clear()
        isPlaying = false; isLoading = false; position = 0.0; duration = 0.0
        showLocal()
        lockScreen?.update(null)
        audioFocus?.deactivate()
        updateTicker()
    }

    internal fun useStore(s: PlayerPersistence) {
        store = s
        if (!model.isEmpty || loadedId != null) return
        val saved = s.load() ?: return
        model = saved.queue; modelVersion++
        savedAt = saved.at
        saved.volume?.let { volume = it; localVolume = it }
        showLocal()
        position = saved.position
        duration = model.current?.track?.duration ?: 0.0
        isPlaying = false
        updateLockScreen()
    }

    private fun persistQueue() {
        val store = store ?: return
        if (mirrorTarget != null) return
        queueSaveTask?.cancel()
        val q = model.copy()
        queueSaveTask = scope.launch {
            delay(1000)
            store.saveQueue(q)
        }
    }

    private fun playhead(): PlayerPersistence.Playhead? {
        val cur = model.current ?: return null
        return PlayerPersistence.Playhead(cur.track.id, model.index, positionNow(), model.repeatMode, model.shuffle, localVolumeNow, now())
    }

    private fun persistPlayhead(force: Boolean) {
        val store = store ?: return
        if (mirrorTarget != null) return
        val h = playhead() ?: return
        lastHeadSave = now()
        savedAt = h.at
        store.savePlayhead(h)
        if (force) persistQueue()
    }

    fun flushPersistence() {
        val store = store ?: return
        if (mirrorTarget != null) return
        queueSaveTask?.cancel()
        val h = playhead()
        if (h != null) savedAt = h.at
        store.flush(model.copy(), h)
    }

    // Helpers

    private inline fun <T> mutate(f: (PlayQueue) -> T): T {
        val r = f(model)
        modelVersion++
        return r
    }

    /** Public state from the local model (not while mirroring). */
    private fun showLocal() {
        if (mirrorTarget != null) return
        if (shownVersion != modelVersion) {
            shownVersion = modelVersion
            val tracks = model.tracks
            if (tracks != queue) queue = tracks
            queuedFlags = model.entries.map { it.queued }
            recFlags = model.entries.map { it.rec }
        }
        index = model.index
        repeatMode = model.repeatMode
        shuffle = model.shuffle
        context = model.context
        if (remoteClientId != null) remoteClientId = null
        if (output.id != "local") output = OutputDevice.local(LOCAL_NAME)
    }

    private fun clampPos(p: Double, dur: Double?): Double =
        if (dur == null || dur <= 0) maxOf(0.0, p) else p.coerceIn(0.0, dur)

    private fun publishState() {
        mutable.value = PlayerState(
            queue = queue, queuedFlags = queuedFlags, recFlags = recFlags, index = index, isPlaying = isPlaying,
            isLoading = isLoading, repeatMode = repeatMode, shuffle = shuffle, context = context, volume = volume,
            output = output, remoteClientId = remoteClientId, error = error, deliveredProfile = deliveredProfile,
        )
    }

    private fun publishProgress() {
        progressFlow.value = PlayerProgress(position, duration, progressTick)
    }

    /** A UI field: setting a new value republishes [state]. */
    private fun <T> ui(initial: T) = object : ReadWriteProperty<Any?, T> {
        private var v = initial
        override fun getValue(thisRef: Any?, property: KProperty<*>): T = v
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: T) {
            if (v == value) return
            v = value
            publishState()
        }
    }

    // Engine events

    override fun audioHeard(id: String) {
        if (id != loadedId || id != model.current?.track?.id) return
        val first = !heard
        if (first) heardAt = now()
        heard = true
        if (isLoading) isLoading = false
        position = positionNow()
        reportNow(); updateLockScreen()
        if (first) warmAhead()
    }

    override fun audioWaiting(id: String) {
        if (id != loadedId || !isPlaying || isLoading) return
        isLoading = true
        reportNow(); updateLockScreen()
    }

    override fun audioEnded(id: String) {
        if (id != loadedId || id != model.current?.track?.id) return
        advance(auto = true)
    }

    override fun audioAdvanced(id: String) {
        val ni = preparedNextIndex
        if (ni == null || ni !in model.entries.indices || model.entries[ni].track.id != id) {
            // The queue moved under a preloaded song: play what the queue says now.
            advance(auto = true)
            return
        }
        preparedNextIndex = null
        model.index = ni
        val track = model.entries[ni].track
        loadedId = id
        deliveredProfile = delivered(audioItem(track))
        startGen++
        heard = true
        heardAt = now()
        showLocal()
        position = 0.0
        duration = track.duration
        isLoading = false
        newListen(id)
        prepareNext()
        reportNow(); updateLockScreen(); persistPlayhead(force = false)
        warmAhead()
        extendEarly()
    }

    override fun audioFailed(id: String, message: String) {
        if (id != loadedId) return
        error = message
        isPlaying = false; isLoading = false
        reportNow(); updateLockScreen(); updateTicker()
    }

    override fun audioDuration(id: String, seconds: Double) {
        if (id != loadedId || abs(seconds - duration) <= 0.5) return
        duration = seconds
        updateLockScreen()
    }

    override fun audioStarved(id: String) { linkWatch?.noteStarve() }

    companion object {
        /** Web locale key; the UI renders `local` as "This Phone" itself. */
        const val LOCAL_NAME = "This Phone"

        /** What an item's URL says about the stream (a file, or the master's `max`). */
        fun delivered(item: AudioItem): DeliveredProfile? {
            if (item.url.isEmpty()) return null
            if (item.url.startsWith("file:")) return DeliveredProfile.File
            val max = Regex("[?&]max=([^&#]+)").find(item.url)?.groupValues?.get(1)
            return DeliveredProfile.Hls(max ?: "aac-320")
        }
    }
}
