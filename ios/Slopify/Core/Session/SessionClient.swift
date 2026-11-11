import Foundation
import UIKit

/// The realtime session over /api/ws (API.md §20). Presence, the roster of this account's
/// other devices and speakers, who is active, and command routing.
///
/// OWNER: session task. Public surface below is the contract other code relies on;
/// changing it needs the lead.
@MainActor @Observable
final class SessionClient {
    enum Connection: Equatable { case disconnected, connecting, connected }

    private(set) var connection: Connection = .disconnected
    /// Server-assigned id for this install (adopt hello-ok.clientId).
    private(set) var clientId: String = ""
    /// Every OTHER client of the account, incl. the virtual server:<uid> speaker client.
    private(set) var players: [RosterPlayer] = []
    private(set) var lanDevices: [LanDevice] = []
    /// Who makes sound now. May be our own clientId.
    private(set) var activeClientId: String?
    /// Queues other clients published, by clientId.
    private(set) var queues: [String: [QueueItem]] = [:]
    /// Last frozen session when nobody is active (`session` message).
    private(set) var lastSession: (nowPlaying: NowPlaying, queue: [QueueItem], at: Double)?
    private(set) var sleep: (at: Double?, endOfTrack: Bool)?
    /// Visualiser latency per speaker id, seconds (hello-ok.offsets + `offset` messages).
    private(set) var offsets: [String: Double] = [:]

    var isActiveHere: Bool { activeClientId != nil && activeClientId == clientId }
    /// The active remote player, if the sound is on another device.
    var remoteActive: RosterPlayer? { players.first { $0.id == activeClientId } }

    /// Commands addressed to this device (from other devices or the server's sleep timer).
    var onCommand: ((Command, _ from: String) -> Void)?
    /// A track like changed anywhere on the account.
    var onLike: ((_ itemId: String, _ liked: Bool) -> Void)?
    /// A prefs patch from another device. `_libraryLayout` rev means re-fetch the layout.
    var onPrefs: (([String: JSONValue]) -> Void)?
    /// 4003: token is dead. Go to sign-in.
    var onSignedOut: (() -> Void)?

    // MARK: private state

    @ObservationIgnored private let makeSocket: (URL) -> SocketTransport
    @ObservationIgnored private let persistedClientId: String
    @ObservationIgnored private var base: URL?
    @ObservationIgnored private var token: String?
    @ObservationIgnored private var socket: SocketTransport?
    @ObservationIgnored private var consumer: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var pingTask: Task<Void, Never>?
    @ObservationIgnored private var reportTask: Task<Void, Never>?
    @ObservationIgnored private var queueTask: Task<Void, Never>?
    @ObservationIgnored private var livenessTask: Task<Void, Never>?
    /// Wanted down: never connected, disconnect(), or 4003.
    @ObservationIgnored private var stopped = true
    /// Closed because the app went to the background with nothing playing.
    @ObservationIgnored private var suspended = false
    @ObservationIgnored private var helloed = false
    @ObservationIgnored private var openedAt: Double?
    @ObservationIgnored private var lastPongAt: Double = 0
    @ObservationIgnored private(set) var backoff = SocketBackoff()
    @ObservationIgnored private var clock = SocketClock()
    @ObservationIgnored private(set) var claimState = SocketClaim()
    @ObservationIgnored private var lastReport: NowPlaying?
    @ObservationIgnored private var lastReportAt: Double = 0
    @ObservationIgnored private var lastQueue: [QueueItem]?
    @ObservationIgnored private var lastQueueFrame: Data?
    /// Local receipt time per roster nowPlaying, the fallback for playhead math (§20.9).
    @ObservationIgnored private var rxAt: [NowPlaying: Double] = [:]
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    convenience init() {
        self.init(defaults: .standard, makeSocket: { SocketConnection(url: $0) })
    }

    init(defaults: UserDefaults, makeSocket: @escaping (URL) -> SocketTransport) {
        self.makeSocket = makeSocket
        persistedClientId = SocketIdentity.clientId(defaults)
        clientId = persistedClientId
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.foreground() }
        })
        observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.background() }
        })
    }

    func connect(base: URL, token: String) {
        // The app calls this on every foreground: same server and token is a no-op unless down.
        if !stopped, self.base?.absoluteString == base.absoluteString, self.token == token {
            if connection == .disconnected { reconnectNow() }
            return
        }
        self.base = base
        self.token = token
        stopped = false
        suspended = false
        reconnectNow()
    }

    func disconnect() {
        stopped = true
        suspended = false
        retryTask?.cancel(); retryTask = nil
        queueTask?.cancel(); queueTask = nil
        reportTask?.cancel(); reportTask = nil
        teardownSocket()
        connection = .disconnected
        base = nil; token = nil
        clientId = persistedClientId
        players = []; lanDevices = []; activeClientId = nil; queues = [:]
        lastSession = nil; sleep = nil; offsets = [:]; rxAt = [:]
        claimState = SocketClaim()
        lastReport = nil; lastQueue = nil; lastQueueFrame = nil
        backoff.reset()
    }

    /// Base URL moved (home <-> main): reconnect there, same clientId/instance.
    func move(to base: URL) {
        guard !stopped, self.base?.absoluteString != base.absoluteString else { return }
        self.base = base
        reconnectNow()
    }

    /// "I am the one making sound now." Call on a local play press.
    func claim() {
        claimState.claim(at: SocketClock.localNow())
        send(.claim(reassertAgo: nil))
    }

    /// Active player only: report state now (call on every change; the client also repeats every 2 s while playing).
    func report(_ np: NowPlaying?) {
        guard mayReport else { return }
        lastReport = np
        lastReportAt = SocketClock.localNow()
        send(.nowPlaying(np))
        scheduleRepeat()
        // Play pressed on the lock screen after we closed for the background.
        if np?.playing == true, suspended { suspended = false; reconnectNow() }
    }

    func publishQueue(_ queue: [QueueItem]) {
        lastQueue = queue
        queueTask?.cancel()
        queueTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            // Encoding up to 5000 items is too slow for the main actor.
            let trimmed = await Task.detached(priority: .userInitiated) { SocketQueueTrim.frame(queue) }.value
            guard !Task.isCancelled, let self else { return }
            self.lastQueue = trimmed.queue
            self.lastQueueFrame = trimmed.frame
            if self.mayReport { self.sendRaw(trimmed.frame) }
        }
    }

    func send(_ command: Command, to clientId: String) { send(.command(command, to: clientId)) }
    func sendPrefs(_ patch: [String: JSONValue]) { send(.prefs(patch)) }
    func setSleep(minutes: Int?) { send(.sleep(minutes.map { .minutes($0) } ?? .off)) }
    func setSleepEndOfTrack() { send(.sleep(.endOfTrack)) }
    func sleepDone() { send(.sleep(.done)) }
    /// Visualiser latency for a speaker, seconds (-5..5), nil forgets it.
    func sendOffset(id: String, offset: Double?) { send(.offset(id: id, offset: offset.map { min(max($0, -5), 5) })) }

    /// Server clock now, ms (clock-synced via ping/pong).
    func serverNow() -> Double { clock.serverNow(localNow: SocketClock.localNow()) }
    /// Extrapolated playhead of a remote NowPlaying, seconds (API.md §20.9).
    func playhead(_ np: NowPlaying) -> Double { clock.playhead(np, rxAt: rxAt[np], localNow: SocketClock.localNow()) }

    // MARK: connection

    /// Mirrors never send nowplaying/queue. Claimed, active, or nobody active (a first
    /// playing report then makes us active) may.
    private var mayReport: Bool { claimState.claimed || activeClientId == nil || activeClientId == clientId }

    private func reconnectNow() {
        retryTask?.cancel(); retryTask = nil
        backoff.reset()
        open()
    }

    private func open() {
        teardownSocket()
        guard !stopped, !suspended, let base else { return }
        connection = .connecting
        let s = makeSocket(SocketIdentity.webSocketURL(base: base))
        socket = s
        consumer = Task { [weak self] in
            for await ev in s.events {
                guard let self, self.socket === s else { return }
                self.handle(ev)
            }
        }
        s.start()
    }

    private func teardownSocket() {
        consumer?.cancel(); consumer = nil
        pingTask?.cancel(); pingTask = nil
        livenessTask?.cancel(); livenessTask = nil
        socket?.close(); socket = nil
        helloed = false
        openedAt = nil
    }

    private func scheduleRetry() {
        guard !stopped, !suspended else { return }
        let delay = backoff.take()
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.retryTask = nil
            self.open()
        }
    }

    /// Internal so tests can drive the state machine with a fake transport.
    func handle(_ event: SocketConnection.Event) {
        switch event {
        case .open:
            openedAt = SocketClock.localNow()
            sendHello()
        case let .message(m):
            handle(m)
        case let .closed(code):
            closed(code: code)
        }
    }

    private func sendHello() {
        guard let socket, let token else { return }
        let hello = SocketOutgoing.Hello(
            token: token, clientId: clientId, instance: SocketIdentity.instance,
            name: String(Account.deviceName.prefix(56)), kind: "phone",
            form: UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone", canPlay: true)
        if let d = try? SocketOutgoing.hello(hello).data() { socket.send(d) }
    }

    private func closed(code: Int?) {
        let lived = openedAt.map { (SocketClock.localNow() - $0) / 1000 }
        teardownSocket()
        connection = .disconnected
        backoff.connectionEnded(lived: lived)
        switch SocketCloseAction(code: code) {
        case .signedOut:
            stopped = true
            retryTask?.cancel(); retryTask = nil
            onSignedOut?()
        case .replaced:
            // Do not fight the socket that replaced us; foreground, move or connect reopen.
            break
        case .shrinkAndReconnect:
            if let q = lastQueue, q.count > 1 {
                let half = Array(q.prefix(q.count / 2))
                lastQueue = half
                lastQueueFrame = SocketQueueTrim.encode(half)
            }
            scheduleRetry()
        case .reconnect:
            scheduleRetry()
        }
    }

    private func handle(_ m: SocketMessage) {
        switch m {
        case let .helloOk(h):
            helloed = true
            connection = .connected
            if let id = h.clientId, !id.isEmpty { clientId = id }
            offsets = h.offsets
            sleep = h.sleep.map { (at: $0.at, endOfTrack: $0.endOfTrack) }
            let now = SocketClock.localNow()
            if let serverNow = h.now { clock.helloOk(now: serverNow, localNow: now, openedAt: openedAt ?? now) }
            startPings()
            // Anything sent before hello-ok was dropped. Claim first so the server marks us
            // active before it sends any roster, then what we last reported.
            if let ago = claimState.reassertAgo(now: now) { send(.claim(reassertAgo: ago)) }
            if mayReport {
                if let np = currentReport() { send(.nowPlaying(np)) }
                if let f = lastQueueFrame { sendRaw(f) }
            }
        case let .pong(now, t):
            let local = SocketClock.localNow()
            lastPongAt = local
            clock.pong(now: now, t: t, localNow: local)
        case let .roster(r):
            players = r.players
            lanDevices = r.lanDevices
            activeClientId = r.activeClientId
            // A roster repeats unchanged reports: keep their first receipt time.
            let rx = SocketClock.localNow()
            var next: [NowPlaying: Double] = [:]
            for p in r.players { if let np = p.nowPlaying { next[np] = rxAt[np] ?? rx } }
            rxAt = next
        case let .queue(from, q):
            if let q { queues[from] = q } else { queues.removeValue(forKey: from) }
        case let .session(np, q, at):
            lastSession = (nowPlaying: np, queue: q, at: at)
        case let .command(cmd, from):
            if cmd == .yield {
                // Another client took over: never reassert, stop reporting.
                claimState.yielded()
                if !from.isEmpty, from != "server" { activeClientId = from }
                lastReport = nil
                lastQueueFrame = nil
                reportTask?.cancel(); reportTask = nil
            }
            onCommand?(cmd, from)
        case let .like(itemId, liked):
            onLike?(itemId, liked)
        case let .prefs(p):
            onPrefs?(p)
        case let .sleep(s):
            sleep = s.map { (at: $0.at, endOfTrack: $0.endOfTrack) }
        case let .offset(id, offset):
            if let offset { offsets[id] = offset } else { offsets.removeValue(forKey: id) }
        case .unknown:
            break
        }
    }

    // MARK: sending

    /// Dropped until hello-ok: the server ignores frames while it verifies the token.
    private func send(_ m: SocketOutgoing) {
        guard let d = try? m.data() else { return }
        sendRaw(d)
    }

    private func sendRaw(_ d: Data) {
        guard helloed, let socket else { return }
        socket.send(d)
    }

    private func ping() { send(.ping(t: SocketClock.localNow())) }

    private func startPings() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.ping()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard !Task.isCancelled else { return }
                self?.ping()
            }
        }
    }

    /// The last report moved forward to now, for repeats and re-sends after a reconnect.
    private func currentReport() -> NowPlaying? {
        guard var np = lastReport else { return nil }
        let now = SocketClock.localNow()
        if np.playing, np.held != true {
            np.position += max(0, now - lastReportAt) / 1000
            if let d = np.duration, d > 0 { np.position = min(np.position, d) }
        }
        np.at = now
        return np
    }

    private func scheduleRepeat() {
        reportTask?.cancel(); reportTask = nil
        guard lastReport?.playing == true else { return }
        reportTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, let self else { return }
                guard self.mayReport, let np = self.currentReport(), np.playing else { return }
                self.send(.nowPlaying(np))
            }
        }
    }

    // MARK: app lifecycle

    private func foreground() {
        guard !stopped else { return }
        suspended = false
        guard connection == .connected else { reconnectNow(); return }
        // A socket kept through the background can be dead without knowing it: no pong, reopen.
        let sentAt = SocketClock.localNow()
        ping()
        livenessTask?.cancel()
        livenessTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self, self.lastPongAt < sentAt else { return }
            self.reconnectNow()
        }
    }

    private func background() {
        // Keep the socket while audio plays; otherwise close cleanly instead of being frozen.
        guard !stopped, lastReport?.playing != true else { return }
        suspended = true
        retryTask?.cancel(); retryTask = nil
        teardownSocket()
        connection = .disconnected
    }
}
