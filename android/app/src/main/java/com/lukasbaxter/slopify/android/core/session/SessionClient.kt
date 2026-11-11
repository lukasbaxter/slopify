package com.lukasbaxter.slopify.android.core.session

import com.lukasbaxter.slopify.android.core.model.Prefs
import com.lukasbaxter.slopify.android.core.storage.KeyValueStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToLong

enum class SessionConnection { Disconnected, Connecting, Connected }

/** The last frozen session when nobody is active (`session` message). `at` epoch ms. */
data class SessionSnapshot(val nowPlaying: NowPlaying, val queue: List<QueueItem>, val at: Double)

/** Everything the session knows, as one snapshot for the UI. */
data class SessionState(
    val connection: SessionConnection = SessionConnection.Disconnected,
    /** Server-assigned id for this install (adopted from hello-ok). */
    val clientId: String = "",
    /** Every OTHER client of the account, incl. the virtual `server:<uid>` speaker client. */
    val players: List<RosterPlayer> = emptyList(),
    val lanDevices: List<LanDevice> = emptyList(),
    /** Who makes sound now. May be our own clientId. */
    val activeClientId: String? = null,
    /** Queues other clients published, by clientId. */
    val queues: Map<String, List<QueueItem>> = emptyMap(),
    val lastSession: SessionSnapshot? = null,
    val sleep: SleepState? = null,
    /** Visualiser latency per speaker id, seconds (hello-ok.offsets + `offset` messages). */
    val offsets: Map<String, Double> = emptyMap(),
) {
    val isActiveHere: Boolean get() = activeClientId != null && activeClientId == clientId
    /** The active remote player, if the sound is on another device. */
    val remoteActive: RosterPlayer? get() = players.firstOrNull { it.id == activeClientId }
}

/**
 * The realtime session over /api/ws (API.md §20): presence, the roster of this account's
 * other devices and speakers, who is active, and command routing.
 *
 * Runs on [scope] (Main in the app): call from there. Socket IO and frame parsing happen on
 * OkHttp threads; events arrive here in order.
 */
class SessionClient(
    private val scope: CoroutineScope,
    idStore: KeyValueStore,
    /** Shown in other devices' pickers (cut to 56 characters). */
    private val deviceName: String,
    /** `phone` | `tablet`. */
    private val form: String,
    private val makeSocket: (url: String) -> SocketTransport,
    /** Epoch ms; tests use virtual time. */
    private val now: () -> Double = SocketClock::localNow,
    /** Where big queue frames are encoded. */
    private val encodeDispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    private val persistedClientId = SocketIdentity.clientId(idStore)
    private val mutable = MutableStateFlow(SessionState(clientId = persistedClientId))
    val state: StateFlow<SessionState> = mutable.asStateFlow()

    /** Commands addressed to this device (from other devices or the server's sleep timer). */
    var onCommand: ((command: Command, from: String) -> Unit)? = null
    /** A track like changed anywhere on the account. */
    var onLike: ((itemId: String, liked: Boolean) -> Unit)? = null
    /** A prefs patch from another device. `_libraryLayout` / `_libraryChanged` mean re-fetch the library. */
    var onPrefs: ((Prefs) -> Unit)? = null
    /** 4003: the token is dead. Go to sign-in. */
    var onSignedOut: (() -> Unit)? = null

    // Private state

    private var base: String? = null
    private var token: String? = null
    private var socket: SocketTransport? = null
    private var consumer: Job? = null
    private var retryJob: Job? = null
    private var pingJob: Job? = null
    private var reportJob: Job? = null
    private var queueJob: Job? = null
    private var livenessJob: Job? = null
    /** Wanted down: never connected, disconnect(), or 4003. */
    private var stopped = true
    /** Closed because the app went to the background with nothing playing. */
    private var suspended = false
    private var helloed = false
    private var openedAt: Double? = null
    private var lastPongAt = 0.0
    internal val backoff = SocketBackoff()
    private var clock = SocketClock()
    internal var claimState = SocketClaim()
        private set
    private var lastReport: NowPlaying? = null
    private var lastReportAt = 0.0
    private var lastQueue: List<QueueItem>? = null
    private var lastQueueFrame: String? = null
    /** Local receipt time per roster nowPlaying, the fallback for playhead math (§20.9). */
    private var rxAt: Map<NowPlaying, Double> = emptyMap()

    val clientId: String get() = mutable.value.clientId

    fun connect(base: String, token: String) {
        // The app calls this on every foreground: same server and token is a no-op unless down.
        if (!stopped && this.base == base && this.token == token) {
            if (mutable.value.connection == SessionConnection.Disconnected) reconnectNow()
            return
        }
        this.base = base
        this.token = token
        stopped = false
        suspended = false
        reconnectNow()
    }

    fun disconnect() {
        stopped = true
        suspended = false
        retryJob?.cancel(); retryJob = null
        queueJob?.cancel(); queueJob = null
        reportJob?.cancel(); reportJob = null
        teardownSocket()
        base = null; token = null
        mutable.value = SessionState(clientId = persistedClientId)
        rxAt = emptyMap()
        claimState = SocketClaim()
        lastReport = null; lastQueue = null; lastQueueFrame = null
        backoff.reset()
    }

    /** Base URL moved (home <-> main): reconnect there, same clientId and instance. */
    fun move(base: String) {
        if (stopped || this.base == base) return
        this.base = base
        reconnectNow()
    }

    /** "I am the one making sound now." Call on a local play press. */
    fun claim() {
        claimState.claim(now())
        send(SocketOutgoing.Claim(null))
    }

    /** Active player only: report state now (on every change; repeated every 2 s while playing). */
    fun report(np: NowPlaying?) {
        if (!mayReport) return
        lastReport = np
        lastReportAt = now()
        send(SocketOutgoing.NowPlayingReport(np))
        scheduleRepeat()
        // Play pressed on the lock screen after we closed for the background.
        if (np?.playing == true && suspended) { suspended = false; reconnectNow() }
    }

    /** Debounced 300 ms; trimmed to the frame budget off the main thread. */
    fun publishQueue(queue: List<QueueItem>) {
        lastQueue = queue
        queueJob?.cancel()
        queueJob = scope.launch {
            delay(300)
            val trimmed = withContext(encodeDispatcher) { SocketQueueTrim.frame(queue) }
            if (!isActive) return@launch
            lastQueue = trimmed.queue
            lastQueueFrame = trimmed.frame
            if (mayReport) sendRaw(trimmed.frame)
        }
    }

    fun send(command: Command, to: String) = send(SocketOutgoing.CommandTo(command, to))
    fun sendPrefs(patch: Prefs) = send(SocketOutgoing.PrefsPatch(patch))
    fun setSleep(minutes: Int?) = send(SocketOutgoing.Sleep(minutes?.let { SocketOutgoing.SleepRequest.Minutes(it) } ?: SocketOutgoing.SleepRequest.Off))
    fun setSleepEndOfTrack() = send(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.EndOfTrack))
    fun sleepDone() = send(SocketOutgoing.Sleep(SocketOutgoing.SleepRequest.Done))
    /** Visualiser latency for a speaker, seconds (-5..5); null forgets it. */
    fun sendOffset(id: String, offset: Double?) = send(SocketOutgoing.Offset(id, offset?.coerceIn(-5.0, 5.0)))

    /** Server clock now, epoch ms (synced via ping/pong). */
    fun serverNow(): Double = clock.serverNow(now())
    /** Extrapolated playhead of a remote NowPlaying, seconds (API.md §20.9). */
    fun playhead(np: NowPlaying): Double = clock.playhead(np, rxAt[np], now())

    // App lifecycle (the app forwards process start/stop)

    fun onForeground() {
        if (stopped) return
        suspended = false
        if (mutable.value.connection != SessionConnection.Connected) { reconnectNow(); return }
        // A socket kept through the background can be dead without knowing it: no pong, reopen.
        val sentAt = now()
        ping()
        livenessJob?.cancel()
        livenessJob = scope.launch {
            delay(4_000)
            if (lastPongAt < sentAt) reconnectNow()
        }
    }

    fun onBackground() {
        // Keep the socket while audio plays; otherwise close cleanly instead of being frozen.
        if (stopped || lastReport?.playing == true) return
        suspended = true
        retryJob?.cancel(); retryJob = null
        teardownSocket()
        mutable.update { it.copy(connection = SessionConnection.Disconnected) }
    }

    // Connection

    /** Mirrors never send nowplaying/queue. Claimed, active, or nobody active may. */
    private val mayReport: Boolean
        get() = claimState.claimed || mutable.value.activeClientId == null || mutable.value.activeClientId == mutable.value.clientId

    private fun reconnectNow() {
        retryJob?.cancel(); retryJob = null
        backoff.reset()
        open()
    }

    private fun open() {
        teardownSocket()
        val base = base
        if (stopped || suspended || base == null) return
        mutable.update { it.copy(connection = SessionConnection.Connecting) }
        val s = makeSocket(SocketIdentity.webSocketUrl(base))
        socket = s
        consumer = scope.launch {
            s.events.collect { ev -> if (socket === s) handle(ev) }
        }
        s.start()
    }

    private fun teardownSocket() {
        consumer?.cancel(); consumer = null
        pingJob?.cancel(); pingJob = null
        livenessJob?.cancel(); livenessJob = null
        socket?.close(); socket = null
        helloed = false
        openedAt = null
    }

    private fun scheduleRetry() {
        if (stopped || suspended) return
        val delaySeconds = backoff.take()
        retryJob?.cancel()
        retryJob = scope.launch {
            delay((delaySeconds * 1000).roundToLong())
            retryJob = null
            open()
        }
    }

    /** Internal so tests can drive the state machine without a transport. */
    internal fun handle(event: SocketEvent) {
        when (event) {
            SocketEvent.Open -> { openedAt = now(); sendHello() }
            is SocketEvent.Message -> handle(event.message)
            is SocketEvent.Closed -> closed(event.code)
        }
    }

    private fun sendHello() {
        val socket = socket ?: return
        val token = token ?: return
        val hello = SocketOutgoing.Hello(
            token = token, clientId = clientId, instance = SocketIdentity.instance,
            name = deviceName.take(56), kind = "phone", form = form, canPlay = true,
        )
        socket.send(hello.text())
    }

    private fun closed(code: Int?) {
        val lived = openedAt?.let { (now() - it) / 1000 }
        teardownSocket()
        mutable.update { it.copy(connection = SessionConnection.Disconnected) }
        backoff.connectionEnded(lived)
        when (SocketCloseAction.of(code)) {
            SocketCloseAction.SignedOut -> {
                stopped = true
                retryJob?.cancel(); retryJob = null
                onSignedOut?.invoke()
            }
            // Do not fight the socket that replaced us; foreground, move or connect reopen.
            SocketCloseAction.Replaced -> Unit
            SocketCloseAction.ShrinkAndReconnect -> {
                val q = lastQueue
                if (q != null && q.size > 1) {
                    val half = q.take(q.size / 2)
                    lastQueue = half
                    lastQueueFrame = SocketQueueTrim.encode(half)
                }
                scheduleRetry()
            }
            SocketCloseAction.Reconnect -> scheduleRetry()
        }
    }

    private fun handle(m: SocketMessage) {
        when (m) {
            is SocketMessage.HelloOk -> {
                helloed = true
                val t = now()
                mutable.update {
                    it.copy(
                        connection = SessionConnection.Connected,
                        clientId = m.clientId?.takeIf { id -> id.isNotEmpty() } ?: it.clientId,
                        offsets = m.offsets,
                        sleep = m.sleep,
                    )
                }
                m.now?.let { clock.helloOk(it, t, openedAt ?: t) }
                startPings()
                // Anything sent before hello-ok was dropped. Claim first so the server marks us
                // active before it sends any roster, then what we last reported.
                claimState.reassertAgo(t)?.let { send(SocketOutgoing.Claim(it)) }
                if (mayReport) {
                    currentReport()?.let { send(SocketOutgoing.NowPlayingReport(it)) }
                    lastQueueFrame?.let { sendRaw(it) }
                }
            }
            is SocketMessage.Pong -> {
                val local = now()
                lastPongAt = local
                clock.pong(m.now, m.t, local)
            }
            is SocketMessage.Roster -> {
                // A roster repeats unchanged reports: keep their first receipt time.
                val rx = now()
                rxAt = m.players.mapNotNull { p -> p.nowPlaying?.let { it to (rxAt[it] ?: rx) } }.toMap()
                mutable.update { it.copy(players = m.players, lanDevices = m.lanDevices, activeClientId = m.activeClientId) }
            }
            is SocketMessage.Queue -> mutable.update {
                it.copy(queues = if (m.queue != null) it.queues + (m.from to m.queue) else it.queues - m.from)
            }
            is SocketMessage.Session -> mutable.update { it.copy(lastSession = SessionSnapshot(m.nowPlaying, m.queue, m.at)) }
            is SocketMessage.CommandFrom -> {
                if (m.command == Command.Yield) {
                    // Another client took over: never reassert, stop reporting.
                    claimState.yielded()
                    if (m.from.isNotEmpty() && m.from != "server") mutable.update { it.copy(activeClientId = m.from) }
                    lastReport = null
                    lastQueueFrame = null
                    reportJob?.cancel(); reportJob = null
                }
                onCommand?.invoke(m.command, m.from)
            }
            is SocketMessage.Like -> onLike?.invoke(m.itemId, m.liked)
            is SocketMessage.PrefsPatch -> onPrefs?.invoke(m.prefs)
            is SocketMessage.Sleep -> mutable.update { it.copy(sleep = m.sleep) }
            is SocketMessage.Offset -> mutable.update {
                it.copy(offsets = if (m.offset != null) it.offsets + (m.id to m.offset) else it.offsets - m.id)
            }
            is SocketMessage.Unknown -> Unit
        }
    }

    // Sending

    /** Dropped until hello-ok: the server ignores frames while it verifies the token. */
    private fun send(m: SocketOutgoing) = sendRaw(m.text())

    private fun sendRaw(text: String) {
        val socket = socket
        if (!helloed || socket == null) return
        socket.send(text)
    }

    private fun ping() = send(SocketOutgoing.Ping(now()))

    private fun startPings() {
        pingJob?.cancel()
        pingJob = scope.launch {
            delay(400)
            ping()
            while (isActive) {
                delay(25_000)
                ping()
            }
        }
    }

    /** The last report moved forward to now, for repeats and re-sends after a reconnect. */
    private fun currentReport(): NowPlaying? {
        val np = lastReport ?: return null
        val t = now()
        var pos = np.position
        if (np.playing && np.held != true) {
            pos += maxOf(0.0, t - lastReportAt) / 1000
            np.duration?.let { d -> if (d > 0) pos = minOf(pos, d) }
        }
        return np.copy(position = pos, at = t)
    }

    private fun scheduleRepeat() {
        reportJob?.cancel(); reportJob = null
        if (lastReport?.playing != true) return
        reportJob = scope.launch {
            while (isActive) {
                delay(2_000)
                if (!mayReport) return@launch
                val np = currentReport() ?: return@launch
                if (!np.playing) return@launch
                send(SocketOutgoing.NowPlayingReport(np))
            }
        }
    }
}
