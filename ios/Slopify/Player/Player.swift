import Foundation
import UIKit

/// What the UI talks to for playback. Plays locally (AVFoundation) when this device is the
/// output, and mirrors + remote-controls when another device or speaker is active
/// (sends Commands through SessionClient). The UI never needs to know which.
///
/// OWNER: player task. The public surface below is the contract every screen relies on;
/// changing it needs the lead.
///
/// Behaviour reference: web/src/player/usePlayer.js (queue rules, advance, transfer,
/// executeCommand). Pure rules live in PlayQueue / StreamPolicy / SessionReports.
@MainActor @Observable
final class Player {
    enum Repeat: String, Sendable { case off, all, one }
    enum Shuffle: String, Sendable { case off, on, smart }

    // State the UI renders (local or mirrored).
    private(set) var queue: [Track] = []
    /// Parallel to `queue`: added with "Add to queue".
    private(set) var queuedFlags: [Bool] = []
    /// Parallel to `queue`: smart-shuffle picks (web `_rec`). All false while mirroring
    /// (published queues do not carry it).
    private(set) var recFlags: [Bool] = []
    private(set) var index: Int = 0
    var current: Track? { queue.indices.contains(index) ? queue[index] : nil }
    private(set) var isPlaying = false
    /// Buffering / not audible yet.
    private(set) var isLoading = false
    /// Seconds. Observe `progressTick` or use a TimelineView for smooth progress.
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    private(set) var repeatMode: Repeat = .off
    private(set) var shuffle: Shuffle = .off
    /// What the queue was started from: album id, playlist id, "artist:<id>", "mix:<id>", "genre:<name>".
    private(set) var context: String?
    /// 0...100
    private(set) var volume: Double = 100
    /// Where the sound is: local, another client, or a speaker.
    private(set) var output: OutputDevice = .local("This Phone")
    /// True while mirroring another device.
    var isRemote: Bool { output.id != "local" || remoteClientId != nil }
    private(set) var remoteClientId: String?
    private(set) var error: String?
    /// How this phone gets the current song: a downloaded file, or HLS capped at a profile.
    /// nil when nothing is loaded here (mirroring, stopped).
    private(set) var deliveredProfile: Delivered?

    enum Delivered: Equatable, Sendable {
        case file
        /// `max` of the HLS master: aac-96 | aac-160 | aac-320 | alac.
        case hls(profile: String)
    }

    /// The error strip was tapped.
    func clearError() { if error != nil { error = nil } }

    /// Seconds between what the engine plays and what is heard (AVAudioSession output
    /// latency), while this phone is the output; 0 otherwise. Clamped to 0...2 like the web.
    func outputLag() -> Double {
        guard mirrorTarget == nil, loadedId != nil, isPlaying else { return 0 }
        let v = audioSession?.outputLatency ?? 0
        return v.isFinite ? min(2, max(0, v)) : 0
    }

    /// Touch-down on a row (TrackRow.jsx `jf.prewarm`): fetch the start of the song's stream so
    /// a tap that follows starts fast. HLS only, once a minute per song.
    func prewarm(_ track: Track) {
        guard let backend, mirrorTarget == nil, localFile?(track.id) == nil else { return }
        let t = now
        if let at = prewarmedAt[track.id], t - at < 60_000 { return }
        prewarmedAt[track.id] = t
        if prewarmedAt.count > 200 { prewarmedAt = prewarmedAt.filter { t - $0.value < 60_000 } }
        let norm = StreamPolicy.normMode(track: track, context: model.context, normalize: StreamPolicy.normalize(prefs: prefs()))
        let master = backend.hlsURL(trackId: track.id, max: profile, norm: norm)
        Task { await backend.prewarm(master: master) }
    }

    // Additive public surface (player task).
    /// Bumps with every position update (about every 0.5 s while playing).
    private(set) var progressTick = 0
    /// trackId -> downloaded file. Checked before streaming (offline task sets it).
    @ObservationIgnored var localFile: ((String) -> URL?)?
    /// Hearts for NowPlaying reports, queue items and the lock screen's like command.
    @ObservationIgnored var likes: Likes?
    /// A play the server could not be told about (no network): queue it for POST /api/plays
    /// with `client: "offline"` later (§13, §15.1). Offline task sets it.
    @ObservationIgnored var onOfflinePlay: ((_ trackId: String, _ at: Double) -> Void)?

    /// The playhead right now (extrapolated), for lyrics and TimelineViews.
    func positionNow() -> Double {
        if let np = mirroredNowPlaying, let link { return clampPos(link.playhead(np), np.duration) }
        if let engine, loadedId != nil, loadedId == model.current?.track.id { return engine.currentTime }
        return position
    }

    // MARK: - Internals

    @ObservationIgnored private(set) var model = PlayQueue()
    @ObservationIgnored private var backend: PlayerBackend?
    @ObservationIgnored private var link: PlayerSessionLink?
    @ObservationIgnored private var prefs: () -> [String: JSONValue] = { [:] }
    @ObservationIgnored private var engine: AudioEngine?
    @ObservationIgnored private var audioSession: AudioSessionControlling?
    @ObservationIgnored private var lockScreen: NowPlayingPublishing?
    @ObservationIgnored private var store: PlayerPersistence?
    @ObservationIgnored private var linkWatch: LinkWatch?
    @ObservationIgnored private weak var account: Account?
    @ObservationIgnored private var accountKey: String?
    @ObservationIgnored var rng = SplitMix64()
    @ObservationIgnored var isTablet = UIDevice.current.userInterfaceIdiom == .pad
    /// The client string for POST /api/plays.
    @ObservationIgnored var playClient = "ios"
    /// Test hook: run Tasks inline-ish by awaiting this.
    @ObservationIgnored private(set) var lastTask: Task<Void, Never>?

    /// Track id the engine holds (nil = nothing loaded: restored, yielded, handed off).
    @ObservationIgnored private(set) var loadedId: String?
    @ObservationIgnored private var startGen = 0
    @ObservationIgnored private var lastSkipAt: Double = 0
    @ObservationIgnored private var heard = false
    @ObservationIgnored private var heardAt: Double = 0
    @ObservationIgnored private var wasActiveHere = false
    @ObservationIgnored private var lastSleepEOT = false
    @ObservationIgnored private var preparedNextIndex: Int?
    @ObservationIgnored private var prepareTask: Task<Void, Never>?
    @ObservationIgnored private var warmTask: Task<Void, Never>?
    @ObservationIgnored private var extendedFor: String?
    @ObservationIgnored private var modelVersion = 0
    @ObservationIgnored private var shownVersion = -1
    @ObservationIgnored private var publishedVersion = -1
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var lastTickAt: Double = 0
    @ObservationIgnored private var lastHeadSave: Double = 0
    @ObservationIgnored private var listen = Listen(id: "", playedFor: 0, logged: true, startedAt: 0)
    @ObservationIgnored private var localVolume: Double = 100
    @ObservationIgnored private var stepper = VolumeStepper()
    @ObservationIgnored private var likedOverride: [String: Bool] = [:]
    @ObservationIgnored private var interruptedWhilePlaying = false
    /// The playhead file's last `at` (ms), compared with a server session (§20.4).
    @ObservationIgnored private(set) var savedAt: Double = 0
    @ObservationIgnored private var lastSessionAt: Double?
    @ObservationIgnored private var wasMirroring = false
    /// After claiming a take-over, the roster still names the old player for a moment.
    @ObservationIgnored private var claimPendingUntil: Double = 0
    @ObservationIgnored private var mirrorRQ: [QueueItem]?
    @ObservationIgnored private var mirrorItemId: String?
    @ObservationIgnored private var trackCache: [String: Track] = [:]
    @ObservationIgnored private var resolving: Set<String> = []
    @ObservationIgnored private var queueSaveTask: Task<Void, Never>?
    @ObservationIgnored private var notes: [NSObjectProtocol] = []
    @ObservationIgnored private var prewarmedAt: [String: Double] = [:]

    private struct Listen { var id: String; var playedFor: Double; var logged: Bool; var startedAt: Double }

    init() {}

    /// Wire to the account and session. Called once by the app.
    func attach(account: Account, session: SessionClient) {
        self.account = account
        let audio = AudioSessionController()
        let engine = AVAudioOutput()
        let center = NowPlayingCenter(handlers: lockScreenHandlers(), artwork: { [weak account] id in
            await account?.api.imageData(id: id, size: 640)
        })
        configure(backend: account.api, link: session, prefs: { [weak account] in account?.prefs ?? [:] },
                  engine: engine, audioSession: audio, lockScreen: center, store: nil)
        linkWatch = LinkWatch()
        playClient = Account.deviceName
        observeAccount()
        let nc = NotificationCenter.default
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willTerminateNotification] {
            notes.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.flushPersistence() }
            })
        }
    }

    /// The testable wiring (attach builds the real pieces and calls this).
    func configure(backend: PlayerBackend, link: PlayerSessionLink, prefs: @escaping () -> [String: JSONValue],
                   engine: AudioEngine, audioSession: AudioSessionControlling?, lockScreen: NowPlayingPublishing?,
                   store: PlayerPersistence?) {
        self.backend = backend
        self.link = link
        self.prefs = prefs
        self.engine = engine
        self.audioSession = audioSession
        self.lockScreen = lockScreen
        engine.events = self
        link.onCommand = { [weak self] cmd, from in self?.handle(cmd, from: from) }
        audioSession?.onInterruptionBegan = { [weak self] in self?.interruptionBegan() }
        audioSession?.onInterruptionEnded = { [weak self] resume in self?.interruptionEnded(resume) }
        audioSession?.onRouteLost = { [weak self] in self?.routeLost() }
        audioSession?.onMediaServicesReset = { [weak self] in self?.mediaServicesReset() }
        if let store { useStore(store) }
        observeSession()
        sessionChanged()
    }

    // MARK: - Starting playback

    func play(_ tracks: [Track], startAt index: Int = 0, context: String? = nil, shuffle: Bool? = nil) {
        guard !tracks.isEmpty else { return }
        let i = tracks.indices.contains(index) ? index : 0
        if let target = mirrorTarget {
            if let shuffle { link?.send(.setShuffle(shuffle ? Shuffle.on.rawValue : Shuffle.off.rawValue), to: target) }
            link?.send(.play(trackIds: tracks.map(\.id), index: i, ctx: context, startAt: nil), to: target)
            return
        }
        if let shuffle { model.shuffle = shuffle ? .on : .off }
        localPlay(tracks, at: i, context: context, startAt: 0)
    }

    func playNext(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        // The protocol has no "play next": the closest command is enqueue.
        if let target = mirrorTarget { link?.send(.enqueue(trackIds: tracks.map(\.id)), to: target); return }
        mutate { _ = $0.insertNext(tracks) }
        afterQueueEdit()
    }

    func addToQueue(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        if let target = mirrorTarget { link?.send(.enqueue(trackIds: tracks.map(\.id)), to: target); return }
        localAdd(tracks)
    }

    /// Radio from a track/artist/album/playlist id (API.md §14).
    func startRadio(seedId: String, context: String?) async {
        guard let backend else { return }
        do {
            let items = StreamPolicy.dropDisliked(try await backend.mix(seedId, limit: 100, mode: "radio").items, prefs: prefs())
            guard !items.isEmpty else { return }
            play(items, startAt: 0, context: context)
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Transport

    func togglePlay() {
        if let target = mirrorTarget {
            // Ask for the opposite of what is shown, never a flip (web toggle).
            if let np = mirroredNowPlaying { link?.send(.setPlaying(!np.playing), to: target) } else { link?.send(.toggle, to: target) }
            return
        }
        localSetPlaying(!isPlaying)
    }

    func setPlaying(_ playing: Bool) {
        if let target = mirrorTarget { link?.send(.setPlaying(playing), to: target); return }
        if isPlaying != playing { localSetPlaying(playing) }
    }

    func next() {
        if let target = mirrorTarget { link?.send(.next, to: target); return }
        advance(auto: false)
    }

    /// Restarts the track if more than 3 s in.
    func previous() {
        if let target = mirrorTarget { link?.send(.previous, to: target); return }
        localPrevious()
    }

    func seek(to seconds: Double) {
        if let target = mirrorTarget {
            link?.send(.seek(pos: seconds), to: target)
            position = seconds
            return
        }
        localSeek(seconds)
    }

    func skip(to index: Int) {
        if let target = mirrorTarget { link?.send(.skipTo(index: index), to: target); return }
        skipLocal(index, debounce: true)
    }

    func setRepeat(_ mode: Repeat) {
        if let target = mirrorTarget { link?.send(.setRepeat(mode.rawValue), to: target); return }
        localSetRepeat(mode)
    }

    func setShuffle(_ mode: Shuffle) {
        if let target = mirrorTarget { link?.send(.setShuffle(mode.rawValue), to: target); return }
        localSetShuffle(mode)
    }

    func setVolume(_ level: Double) {
        let l = max(0, min(100, level))
        if let target = mirrorTarget { volume = l; link?.send(.setVolume(level: l), to: target); return }
        localSetVolume(l)
    }

    // MARK: - Queue editing

    func removeFromQueue(at index: Int) {
        if let target = mirrorTarget { link?.send(.queueRemove(index: index), to: target); return }
        if mutate({ $0.remove(at: index) }) { afterQueueEdit() }
    }

    func moveInQueue(from: Int, to: Int) {
        if let target = mirrorTarget { link?.send(.queueMove(from: from, to: to), to: target); return }
        if mutate({ $0.move(from: from, to: to) }) { afterQueueEdit() }
    }

    func clearQueued() {
        if let target = mirrorTarget { link?.send(.queueClear, to: target); return }
        mutate { $0.clearQueued() }
        afterQueueEdit()
    }

    // MARK: - Output

    /// Move playback to another client (`clientId`) or a speaker (`LanDevice`), or back here (nil).
    func transfer(toClient clientId: String?) {
        if let clientId, clientId != link?.clientId { handOff(to: clientId, deviceId: "local") } else { takeOverHere() }
    }

    func transfer(toSpeaker device: LanDevice) {
        guard let via = device.viaClient ?? link?.players.first(where: \.isServer)?.id else { return }
        handOff(to: via, deviceId: device.id)
    }

    // MARK: - Mirror (another client is active)

    private var now: Double { Date().timeIntervalSince1970 * 1000 }

    /// Who controls go to: the active client, when it is another one.
    private var mirrorTarget: String? {
        guard let link, let id = link.activeClientId, id != link.clientId, now >= claimPendingUntil,
              link.players.contains(where: { $0.id == id }) else { return nil }
        return id
    }

    private var mirroredNowPlaying: NowPlaying? {
        guard let id = mirrorTarget else { return nil }
        return link?.players.first { $0.id == id }?.nowPlaying
    }

    private func observeSession() {
        guard let link else { return }
        withObservationTracking {
            _ = link.activeClientId; _ = link.players; _ = link.queues; _ = link.clientId
            _ = link.lastSession?.at; _ = link.sleep?.endOfTrack; _ = link.connection
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.sessionChanged()
                self?.observeSession()
            }
        }
    }

    /// Roster / queues / session snapshot changed.
    func sessionChanged() {
        guard let link else { return }
        if let target = mirrorTarget {
            if remoteClientId == nil { enterMirror() }
            syncMirror(target)
        } else if remoteClientId != nil {
            leaveMirror()
        }
        let activeHere = link.activeClientId != nil && link.activeClientId == link.clientId
        if activeHere { claimPendingUntil = 0 }
        if activeHere, !wasActiveHere {
            // Just became the active player: everyone needs our state and queue now.
            publishedVersion = -1
            reportNow(); publishQueueIfNeeded()
        }
        wasActiveHere = activeHere
        if link.activeClientId == nil, let s = link.lastSession, s.at != lastSessionAt {
            lastSessionAt = s.at
            adoptSession(s.nowPlaying, s.queue, at: s.at)
        }
        let eot = link.sleep?.endOfTrack == true
        if eot != lastSleepEOT { lastSleepEOT = eot; prepareNext() }
    }

    private func enterMirror() {
        wasMirroring = true
        localVolume = volume
        // Not the sound source: the lock screen belongs to whoever plays (yield unloads us).
        if loadedId == nil || !isPlaying { lockScreen?.update(nil) }
    }

    private func leaveMirror() {
        remoteClientId = nil
        mirrorRQ = nil; mirrorItemId = nil
        output = .local(output.id == "local" ? output.name : "This Phone")
        shownVersion = -1
        showLocal()
        isPlaying = loadedId != nil && isPlaying
        isLoading = false
        volume = localVolume
        position = loadedId != nil ? positionNow() : position
        duration = model.current?.track.duration ?? 0
        updateLockScreen()
        updateTicker()
    }

    private func syncMirror(_ target: String) {
        guard let link, let p = link.players.first(where: { $0.id == target }) else { return }
        if remoteClientId != target { remoteClientId = target }
        let np = p.nowPlaying
        let dev = np?.device.flatMap { $0.id == "local" ? nil : $0 } ?? OutputDevice(id: target, kind: p.kind ?? "client", name: p.name)
        if output != dev { output = dev }
        let rq = link.queues[target] ?? []
        if let np {
            if rq != mirrorRQ || np.itemId != mirrorItemId { rebuildMirrorQueue(np, rq) }
            set(\.isPlaying, np.playing)
            set(\.isLoading, np.held ?? false)
            set(\.position, clampPos(link.playhead(np), np.duration))
            set(\.duration, np.duration ?? current?.duration ?? 0)
            if let v = np.volume { set(\.volume, v) }
            if let r = np.repeat.flatMap(Repeat.init(rawValue:)) { set(\.repeatMode, r) }
            if let s = np.shuffle.flatMap(Shuffle.init(rawValue:)) { set(\.shuffle, s) }
        } else {
            mirrorRQ = nil; mirrorItemId = nil
            if !queue.isEmpty { queue = []; queuedFlags = [] }
            set(\.index, 0); set(\.isPlaying, false); set(\.isLoading, false); set(\.position, 0); set(\.duration, 0)
        }
        updateTicker()
    }

    private func rebuildMirrorQueue(_ np: NowPlaying, _ rq: [QueueItem]) {
        mirrorRQ = rq; mirrorItemId = np.itemId
        var tracks = rq.map { trackCache[$0.Id] ?? Track(item: $0) }
        var flags = rq.map { $0._queued ?? false }
        var i = SessionReports.queueIndex(np, in: rq) ?? rq.firstIndex { $0.Id == np.itemId } ?? -1
        if i < 0 { tracks = [trackCache[np.itemId] ?? Track(nowPlaying: np)]; flags = [false]; i = 0 }
        if tracks.map(\.id) != queue.map(\.id) || tracks != queue { queue = tracks; queuedFlags = flags; recFlags = flags.map { _ in false } }
        set(\.index, i)
        resolve(Array(tracks.dropFirst(max(0, i - 50)).prefix(250).map(\.id)))
    }

    /// Fill provisional (socket) tracks with full records, cached (§20.6 mirrors).
    private func resolve(_ ids: [String]) {
        guard let backend else { return }
        let missing = ids.filter { trackCache[$0] == nil && !resolving.contains($0) }
        guard !missing.isEmpty else { return }
        resolving.formUnion(missing)
        lastTask = Task { [weak self] in
            let got = (try? await backend.tracks(ids: missing)) ?? []
            guard let self else { return }
            self.resolving.subtract(missing)
            for t in got { self.trackCache[t.id] = t }
            guard !got.isEmpty else { return }
            if let target = self.mirrorTarget, let np = self.mirroredNowPlaying {
                self.rebuildMirrorQueue(np, self.link?.queues[target] ?? [])
            } else {
                let byId = Dictionary(got.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
                self.mutate { q in
                    for k in q.entries.indices { if let t = byId[q.entries[k].track.id] { q.entries[k].track = t } }
                    for k in q.original.indices { if let t = byId[q.original[k].track.id] { q.original[k].track = t } }
                }
                self.showLocal()
                self.updateLockScreen()
            }
        }
    }

    /// The server's remembered session (§20.4 `session`): adopt it paused unless this
    /// device plays, has something loaded, or remembers a newer playhead (web `applySession`).
    private func adoptSession(_ np: NowPlaying, _ items: [QueueItem], at: Double) {
        guard !np.itemId.isEmpty else { return }
        if !model.isEmpty, isPlaying, loadedId != nil { return }
        if !wasMirroring {
            if !model.isEmpty, loadedId != nil { return }
            if !model.isEmpty, savedAt >= at { return }
        }
        var rows = items.map { QueueEntry(track: trackCache[$0.Id] ?? Track(item: $0), queued: $0._queued ?? false) }
        var i = SessionReports.queueIndex(np, in: items) ?? items.firstIndex { $0.Id == np.itemId } ?? -1
        if i < 0 { rows = [QueueEntry(track: Track(nowPlaying: np))]; i = 0 }
        mutate { q in
            q.adopt(rows, index: i, context: nil)
            if let r = np.repeat.flatMap(Repeat.init(rawValue:)) { q.repeatMode = r }
            if let s = np.shuffle.flatMap(Shuffle.init(rawValue:)) { q.shuffle = s }
        }
        wasMirroring = false
        engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
        showLocal()
        let dur = model.current?.track.duration ?? 0
        isPlaying = false; isLoading = false
        position = clampPos(np.position, dur > 0 ? dur : nil)
        duration = dur
        persistQueue(); persistPlayhead(force: true)
        updateLockScreen()
        resolve(Array(rows.dropFirst(max(0, i - 50)).prefix(250).map(\.track.id)))
    }

    // MARK: - Transfer (§20.6)

    private func handOff(to target: String, deviceId: String) {
        guard let link else { return }
        let payload: Command.Transfer
        if let active = mirrorTarget, let np = mirroredNowPlaying {
            if active == target, deviceId == "local" { return }
            let t = SessionReports.takeOver(np, queue: link.queues[active] ?? [])
            payload = Command.Transfer(trackIds: t.ids, queued: t.queued, index: t.index, position: link.playhead(np),
                                       playing: np.playing, ctx: nil, original: nil, deviceId: deviceId)
        } else {
            guard model.current != nil else { return }
            payload = model.transfer(position: positionNow(), playing: isPlaying, deviceId: deviceId)
        }
        link.send(.transfer(payload), to: target)
        if mirrorTarget == nil { stopForHandOff() }
    }

    /// Our audio stops at once so two devices never overlap (we also get `yield`).
    private func stopForHandOff() {
        let pos = positionNow()
        engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
        startGen += 1
        isPlaying = false; isLoading = false
        position = pos
        persistPlayhead(force: true)
        lockScreen?.update(nil)
        audioSession?.deactivate()
        updateTicker()
    }

    /// "Play here": claim, take the active's queue, start at its extrapolated playhead.
    private func takeOverHere() {
        guard let link, let active = mirrorTarget else {
            if model.current != nil, !isPlaying { localSetPlaying(true) }
            return
        }
        let np = mirroredNowPlaying
        let rq = link.queues[active] ?? []
        link.claim()
        claimPendingUntil = now + 5000
        guard let np else { leaveMirror(); return }
        let t = SessionReports.takeOver(np, queue: rq)
        let rows: [QueueEntry] = t.ids.count == rq.count && !rq.isEmpty
            ? rq.map { QueueEntry(track: trackCache[$0.Id] ?? Track(item: $0), queued: $0._queued ?? false) }
            : [QueueEntry(track: trackCache[np.itemId] ?? Track(nowPlaying: np))]
        let from = link.playhead(np)
        leaveMirror()
        mutate { q in
            q.adopt(rows, index: t.index, context: nil)
            if let r = np.repeat.flatMap(Repeat.init(rawValue:)) { q.repeatMode = r }
            if let s = np.shuffle.flatMap(Shuffle.init(rawValue:)) { q.shuffle = s }
        }
        error = nil
        startLocal(model.index, at: from, play: true)
        resolve(Array(rows.dropFirst(max(0, t.index - 50)).prefix(250).map(\.track.id)))
    }

    // MARK: - Commands (§20.5), executed here as the active player

    func handle(_ command: Command, from: String) {
        switch command {
        case let .play(ids, i, ctx, startAt):
            guard !ids.isEmpty else { return }
            let chosen = ids[min(max(0, i), ids.count - 1)]
            lastTask = Task { [weak self] in
                guard let self, let first = await self.fetch([chosen]).first else { return }
                self.localPlay([first], at: 0, context: ctx, startAt: startAt ?? 0)
                guard ids.count > 1 else { return }
                let all = await self.fetch(ids)
                guard self.model.current?.track.id == chosen, !all.isEmpty else { return }
                let at = max(0, all.firstIndex { $0.id == chosen } ?? 0)
                self.mutate { $0.start(all, at: at, context: ctx, using: &self.rng) }
                self.afterQueueEdit()
            }
        case let .transfer(t):
            receiveTransfer(t)
        case let .enqueue(ids):
            lastTask = Task { [weak self] in
                guard let self else { return }
                let tracks = await self.fetch(ids)
                if !tracks.isEmpty { self.localAdd(tracks) }
            }
        case let .queueRemove(i): if mutate({ $0.remove(at: i) }) { afterQueueEdit() }
        case let .queueMove(f, t): if mutate({ $0.move(from: f, to: t) }) { afterQueueEdit() }
        case .queueClear: mutate { $0.clearQueued() }; afterQueueEdit()
        case let .skipTo(i): skipLocal(i, debounce: true)
        case .toggle: localSetPlaying(!isPlaying)
        case let .setPlaying(p): if isPlaying != p { localSetPlaying(p) }
        case let .seek(pos): localSeek(pos)
        case let .setVolume(l): localSetVolume(max(0, min(100, l)))
        case let .volumeStep(s):
            if let v = stepper.step(from: volume.rounded(), step: s, now: now) { localSetVolume(v) }
        case .next: advance(auto: false)
        case .previous: localPrevious()
        case let .setRepeat(m): localSetRepeat(Repeat(rawValue: m) ?? .off)
        case let .setShuffle(m): localSetShuffle(Shuffle(rawValue: m) ?? .off)
        case let .patchLiked(id, liked):
            likedOverride[id] = liked
            reportNow(); updateLockScreen()
        case .yield: yieldHere()
        case .unknown: break
        }
    }

    /// Another client handed the session to us: claim, start the chosen song from its own
    /// record, fill in the queue behind it (web executeCommand 'transfer').
    private func receiveTransfer(_ t: Command.Transfer) {
        guard !t.trackIds.isEmpty else { return }
        link?.claim()
        claimPendingUntil = now + 5000
        // iOS drives no speakers itself: a speaker id here still plays on this phone.
        let chosen = t.trackIds[min(max(0, t.index), t.trackIds.count - 1)]
        if remoteClientId != nil { leaveMirror() }
        lastTask = Task { [weak self] in
            guard let self else { return }
            guard let first = await self.fetch([chosen]).first else {
                self.error = PlayerText.format("Could not take over playback: {error}", ["error": "track not found"])
                return
            }
            self.mutate { $0.adopt([QueueEntry(track: first)], index: 0, context: t.ctx) }
            self.error = nil
            self.startLocal(0, at: t.position, play: t.playing)
            guard t.trackIds.count > 1 else { return }
            let all = await self.fetch(t.trackIds)
            guard self.model.current?.track.id == chosen, !all.isEmpty else { return }
            let rows = [QueueEntry].marked(all, ids: t.trackIds, flags: t.queued)
            let at = max(0, rows.firstIndex { $0.track.id == chosen } ?? 0)
            let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let orig = t.original?.compactMap { byId[$0] }.map { QueueEntry(track: $0) }
            self.mutate { $0.adopt(rows, index: at, original: orig, context: t.ctx) }
            self.afterQueueEdit()
        }
    }

    /// Another client took over: stop and unload, forget the claim (the session client does),
    /// become a mirror (web `yieldRef`).
    private func yieldHere() {
        let pos = positionNow()
        engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
        startGen += 1
        claimPendingUntil = 0
        isPlaying = false; isLoading = false
        position = pos
        persistPlayhead(force: true)
        lockScreen?.update(nil)
        audioSession?.deactivate()
        updateTicker()
        sessionChanged()
    }

    private func fetch(_ ids: [String]) async -> [Track] {
        let missing = ids.filter { trackCache[$0] == nil }
        if !missing.isEmpty, let backend, let got = try? await backend.tracks(ids: missing) {
            for t in got { trackCache[t.id] = t }
        }
        return ids.compactMap { trackCache[$0] }
    }

    // MARK: - Local playback

    private func localPlay(_ tracks: [Track], at i: Int, context ctx: String?, startAt: Double) {
        link?.claim()
        error = nil
        mutate { $0.start(tracks, at: i, context: ctx, using: &self.rng) }
        startLocal(model.index, at: max(0, startAt), play: true)
    }

    private func localAdd(_ tracks: [Track]) {
        let wasEmpty = mutate { $0.add(tracks) }
        if wasEmpty {
            engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
            showLocal()
            isPlaying = false; isLoading = false; position = 0
            duration = model.current?.track.duration ?? 0
            updateLockScreen()
        }
        afterQueueEdit()
    }

    /// Start entry `i` (web startOn via skipTo / playQueue). `play: false` shows it paused,
    /// nothing loaded (a paused hand-over).
    private func startLocal(_ i: Int, at pos: Double, play: Bool, debounce: Bool = false) {
        guard model.entries.indices.contains(i) else { return }
        model.index = i
        let track = model.entries[i].track
        startGen += 1
        let gen = startGen
        heard = false
        preparedNextIndex = nil
        prepareTask?.cancel(); warmTask?.cancel()
        showLocal()
        position = pos
        duration = track.duration
        isPlaying = play
        isLoading = play
        newListen(track.id)
        if play {
            let t = now
            let rapid = debounce && t - lastSkipAt < 300
            lastSkipAt = t
            if rapid {
                // Hunting through the queue: one start after the taps stop, not ten.
                lastTask = Task { [weak self] in
                    try? await Task.sleep(for: .milliseconds(300))
                    self?.load(track, at: pos, gen: gen)
                }
            } else {
                load(track, at: pos, gen: gen)
            }
        } else {
            engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
        }
        reportNow()
        updateLockScreen()
        persistPlayhead(force: true)
        publishQueueIfNeeded()
        extendEarly()
        updateTicker()
    }

    private func load(_ track: Track, at pos: Double, gen: Int) {
        guard gen == startGen, let engine else { return }
        audioSession?.activate()
        engine.setVolume(Float(localVolumeNow / 100))
        let item = audioItem(for: track)
        engine.load(item, at: pos, play: true)
        loadedId = track.id
        set(\.deliveredProfile, Self.delivered(item))
        prepareNext()
    }

    private var localVolumeNow: Double { remoteClientId == nil ? volume : localVolume }

    /// web `skipTo`: past the end parks on the last song at 0:00, paused.
    private func skipLocal(_ i: Int, debounce: Bool = false) {
        guard !model.isEmpty else { return }
        if i >= model.entries.count {
            engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
            startGen += 1
            model.index = model.entries.count - 1
            showLocal()
            isPlaying = false; isLoading = false; position = 0
            duration = model.current?.track.duration ?? 0
            reportNow(); updateLockScreen(); persistPlayhead(force: true); updateTicker()
            return
        }
        startLocal(max(0, i), at: 0, play: true, debounce: debounce)
    }

    private func localSetPlaying(_ want: Bool) {
        guard let cur = model.current else { return }
        if want {
            link?.claim()
            if loadedId != cur.track.id || engine?.currentId != cur.track.id {
                // Restored, yielded or dead: load it here at the remembered playhead.
                startLocal(model.index, at: position, play: true)
                return
            }
            audioSession?.activate()
            engine?.play()
            isPlaying = true
            isLoading = !heard
        } else {
            engine?.pause()
            position = positionNow()
            isPlaying = false
            isLoading = false
            persistPlayhead(force: true)
        }
        reportNow(); updateLockScreen(); updateTicker()
    }

    private func localPrevious() {
        switch model.previous(position: positionNow()) {
        case .skip(let i): skipLocal(i, debounce: true)
        default:
            // Same song: rewind in place when it is loaded (web), else start it.
            if let cur = model.current, loadedId == cur.track.id {
                engine?.seek(to: 0)
                position = 0
                isLoading = isPlaying
                newListen(cur.track.id)
                reportNow(); updateLockScreen()
            } else {
                skipLocal(model.index)
            }
        }
    }

    private func localSeek(_ s: Double) {
        guard let cur = model.current else { return }
        let target = clampPos(s, cur.track.duration > 0 ? cur.track.duration : nil)
        position = target
        if loadedId == cur.track.id {
            engine?.seek(to: target)
            isLoading = isPlaying
        }
        reportNow(); updateLockScreen(); persistPlayhead(force: true)
    }

    private func localSetVolume(_ l: Double) {
        volume = l
        localVolume = l
        engine?.setVolume(Float(l / 100))
        reportNow()
    }

    private func localSetRepeat(_ mode: Repeat) {
        mutate { $0.repeatMode = mode }
        repeatMode = mode
        prepareNext(); reportNow(); persistPlayhead(force: true)
        extendEarly()
    }

    private func localSetShuffle(_ mode: Shuffle) {
        let was = model.shuffle
        mutate { $0.setShuffle(mode, using: &self.rng) }
        afterQueueEdit()
        if mode == .smart, was != .smart { blendSmart() }
    }

    /// web `advance`.
    private func advance(auto: Bool) {
        guard !model.isEmpty else { return }
        let a = model.advance(auto: auto, sleepEndOfTrack: link?.sleep?.endOfTrack == true)
        switch a {
        case .skip(let i): skipLocal(i, debounce: !auto)
        case .replay: startLocal(model.index, at: 0, play: true)
        case .restart:
            mutate { $0.restartOrder(using: &self.rng) }
            publishQueueIfNeeded()
            startLocal(0, at: 0, play: true)
        case .moreOfArtist(let id): moreOfArtist(id)
        case .autoplay(let orRestart): autoplay(orRestart: orRestart)
        case .sleepStop(let n):
            engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
            startGen += 1
            model.index = n
            showLocal()
            isPlaying = false; isLoading = false; position = 0
            duration = model.current?.track.duration ?? 0
            link?.sleepDone()
            reportNow(); updateLockScreen(); persistPlayhead(force: true); updateTicker()
        }
    }

    /// web `smartNext`: similar songs appended; none -> start over (with a context) or park.
    private func autoplay(orRestart: Bool) {
        guard let backend, let cur = model.current else { return }
        let gen = startGen
        let mode = model.shuffle == .smart ? "smart" : "continue"
        lastTask = Task { [weak self] in
            let fresh = (try? await backend.mix(cur.track.id, limit: 25, mode: mode).items) ?? []
            guard let self, gen == self.startGen else { return }
            let pick = StreamPolicy.dropDisliked(fresh, prefs: self.prefs())
            let n = self.mutate { $0.appendAutoplay(pick, seedId: cur.track.id, fallbackAllowNonSeed: true, using: &self.rng) }
            if n > 0 { self.publishQueueIfNeeded(); self.skipLocal(self.model.index + 1) }
            else { self.skipLocal(orRestart ? 0 : self.model.entries.count) }
        }
    }

    /// web `moreOfArtist`: everything by them not queued yet, shuffled; then a mix; then start over.
    private func moreOfArtist(_ artistId: String) {
        guard let backend else { return }
        let gen = startGen
        lastTask = Task { [weak self] in
            guard let self else { return }
            let have = Set(self.model.entries.map(\.track.id))
            var pick = ((try? await backend.artist(artistId).tracks) ?? []).filter { !have.contains($0.id) }
            pick = StreamPolicy.dropDisliked(pick, prefs: self.prefs()).shuffled(using: &self.rng)
            if pick.isEmpty {
                pick = StreamPolicy.dropDisliked((try? await backend.mix(artistId, limit: 25, mode: nil).items) ?? [], prefs: self.prefs())
                    .filter { !have.contains($0.id) }
            }
            guard gen == self.startGen else { return }
            if pick.isEmpty || self.mutate({ $0.appendMore(pick) }) == 0 {
                self.mutate { $0.restartOrder(using: &self.rng) }
                self.startLocal(0, at: 0, play: true)
            } else {
                self.publishQueueIfNeeded()
                self.skipLocal(self.model.index + 1)
            }
        }
    }

    /// Two songs before the end, the autoplay songs are appended so they preload and play
    /// gapless (web "queue extended early").
    private func extendEarly() {
        guard let backend, mirrorTarget == nil, model.wantsEarlyExtension(remoteActive: false),
              let last = model.entries.last?.track, extendedFor != last.id else { return }
        extendedFor = last.id
        let mode = model.shuffle == .smart ? "smart" : "continue"
        lastTask = Task { [weak self] in
            do {
                let fresh = try await backend.mix(last.id, limit: 25, mode: mode).items
                guard let self, self.model.entries.last?.track.id == last.id else { return }
                let pick = StreamPolicy.dropDisliked(fresh, prefs: self.prefs())
                if self.mutate({ $0.appendAutoplay(pick, seedId: last.id, using: &self.rng) }) > 0 { self.afterQueueEdit() }
            } catch {
                self?.extendedFor = nil
            }
        }
    }

    /// web `blendSmart`.
    private func blendSmart() {
        guard let backend, let cur = model.current, model.entries.count - model.index >= 4 else { return }
        let want = model.smartWant
        let version = modelVersion
        lastTask = Task { [weak self] in
            guard let recs = try? await backend.mix(cur.track.id, limit: want + 1, mode: "smart").items, let self else { return }
            guard self.model.shuffle == .smart, self.modelVersion == version, self.model.current?.track.id == cur.track.id else { return }
            let picks = Array(StreamPolicy.dropDisliked(recs, prefs: self.prefs()).prefix(want))
            if self.mutate({ $0.blendSmart(picks) }) > 0 { self.afterQueueEdit() }
        }
    }

    private func afterQueueEdit() {
        showLocal()
        prepareNext()
        publishQueueIfNeeded()
        persistQueue()
        reportNow()
        updateLockScreen()
        extendEarly()
    }

    // MARK: - Streams

    private var quality: String { StreamPolicy.quality(prefs: prefs(), tablet: isTablet) }

    private var profile: String {
        let p = StreamPolicy.profile(forQuality: quality)
        return linkWatch?.profile(p) ?? p
    }

    /// What an item's URL says about the stream (a file, or the master's `max`).
    static func delivered(_ item: AudioItem) -> Delivered? {
        if item.url.isFileURL { return item.url.path == "/dev/null" ? nil : .file }
        let max = URLComponents(url: item.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "max" }?.value
        return .hls(profile: max ?? "aac-320")
    }

    func audioItem(for track: Track) -> AudioItem {
        let norm = StreamPolicy.normalize(prefs: prefs())
        let mode = StreamPolicy.normMode(track: track, context: model.context, normalize: norm)
        if let file = localFile?(track.id) {
            let p = quality == "original" ? "alac" : "aac"
            return AudioItem(id: track.id, url: file,
                             gain: StreamPolicy.clientGain(track: track, context: model.context, normalize: norm, profile: p),
                             duration: track.duration)
        }
        let p = profile
        let url = backend?.hlsURL(trackId: track.id, max: p, norm: mode) ?? URL(fileURLWithPath: "/dev/null")
        return AudioItem(id: track.id, url: url,
                         gain: StreamPolicy.clientGain(track: track, context: model.context, normalize: norm, profile: p),
                         duration: track.duration)
    }

    /// Give the engine what follows the current song, after this one has a head start on
    /// the network (web: next songs wait until the current one has buffer in hand).
    /// How long the current song plays before the next one is fetched.
    static var headStartMs: Double = 4000

    private func prepareNext() {
        prepareTask?.cancel(); prepareTask = nil
        guard let engine else { return }
        guard mirrorTarget == nil, let cur = model.current, loadedId == cur.track.id,
              let ni = model.upcomingIndex, link?.sleep?.endOfTrack != true else {
            preparedNextIndex = nil
            engine.setNext(nil, transition: .none)
            return
        }
        let next = model.entries[ni].track
        let tr: AudioTransition
        if ni == model.index {
            tr = .gapless   // repeat one: the same song again, seamless
        } else {
            let p = prefs()
            tr = StreamPolicy.transition(current: cur.track, next: next, context: model.context,
                                         crossfade: StreamPolicy.crossfadeSetting(prefs: p), gapless: StreamPolicy.gapless(prefs: p),
                                         repeatOne: false, sleepEndOfTrack: false)
        }
        let item = audioItem(for: next)
        let id = cur.track.id
        let apply = { [weak self] in
            guard let self, self.model.current?.track.id == id, self.loadedId == id else { return }
            self.preparedNextIndex = ni
            self.engine?.setNext(item, transition: tr)
        }
        if heard, now - heardAt >= Self.headStartMs { apply(); return }
        prepareTask = Task { [weak self] in
            while let self, !Task.isCancelled, !self.heard || self.now - self.heardAt < Self.headStartMs {
                try? await Task.sleep(for: .milliseconds(250))
            }
            guard !Task.isCancelled else { return }
            apply()
        }
    }

    /// §12.4: the next songs transcoded server-side, a few seconds after this one sounds.
    private func warmAhead() {
        warmTask?.cancel()
        guard let backend, let cur = model.current else { return }
        let id = cur.track.id
        warmTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, !Task.isCancelled, self.model.current?.track.id == id, self.isPlaying else { return }
            let ids = StreamPolicy.warmIds(entries: self.model.entries, index: self.model.index, repeatAll: self.model.repeatMode == .all)
            guard !ids.isEmpty else { return }
            let nextTrack = self.model.upcoming?.track ?? cur.track
            let norm = StreamPolicy.normMode(track: nextTrack, context: self.model.context, normalize: StreamPolicy.normalize(prefs: self.prefs()))
            try? await backend.warm(ids: ids, profile: self.profile, norm: norm)
        }
    }

    // MARK: - Reports (§20.5, §15.1)

    private func isReporter() -> Bool {
        guard let link, mirrorTarget == nil else { return false }
        return loadedId != nil || isPlaying || link.activeClientId == link.clientId
    }

    private func liked(_ id: String) -> Bool { likedOverride[id] ?? likes?.isLiked(id) ?? false }

    private func reportNow() {
        guard let link, isReporter() else { return }
        guard let cur = model.current?.track else { link.report(nil); return }
        link.report(SessionReports.nowPlaying(.init(
            track: cur, index: model.index, playing: isPlaying, held: isLoading, position: positionNow(),
            duration: duration > 0 ? duration : cur.duration, volume: volume, repeatMode: model.repeatMode, shuffle: model.shuffle,
            liked: liked(cur.id), device: .local(output.id == "local" ? output.name : "This Phone"), artUrl: artURL(cur.id), now: now)))
    }

    private func artURL(_ id: String) -> String? {
        guard let backend, var c = URLComponents(url: backend.imageURL(id: id, size: 128, banner: false, bust: nil), resolvingAgainstBaseURL: false) else { return nil }
        if let token = backend.token { c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "token", value: token)] }
        return c.url?.absoluteString
    }

    private func publishQueueIfNeeded() {
        guard let link, isReporter(), publishedVersion != modelVersion else { return }
        publishedVersion = modelVersion
        link.publishQueue(model.entries.map { QueueItem($0.track, queued: $0.queued, liked: liked($0.track.id)) })
    }

    private func newListen(_ id: String) {
        listen = Listen(id: id, playedFor: 0, logged: false, startedAt: now)
    }

    /// The server logs a play after 8 s of `playing` reports. Without a socket we POST it.
    func countListen(_ dt: Double) {
        guard isPlaying, !isLoading, !listen.logged, listen.id == loadedId else { return }
        listen.playedFor += dt
        guard listen.playedFor >= 8 else { return }
        listen.logged = true
        guard link?.connection != .connected, let backend else { return }
        let id = listen.id, at = listen.startedAt, client = playClient
        lastTask = Task { [weak self] in
            do { try await backend.postPlay(trackId: id, at: at, client: client) }
            catch APIError.offline { self?.onOfflinePlay?(id, at) }
            catch {}
        }
    }

    // MARK: - Lock screen

    private func updateLockScreen() {
        guard let lockScreen else { return }
        guard mirrorTarget == nil, let cur = model.current?.track else { lockScreen.update(nil); return }
        lockScreen.update(LockScreenInfo(
            id: cur.id, title: cur.title, artist: cur.creditLine, album: cur.album,
            duration: duration > 0 ? duration : cur.duration, elapsed: positionNow(),
            rate: isPlaying && !isLoading ? 1 : 0, index: model.index, count: model.entries.count,
            liked: liked(cur.id), artId: cur.id))
    }

    private func lockScreenHandlers() -> NowPlayingCenter.Handlers {
        .init(play: { [weak self] in self?.remoteCommand { $0.setPlaying(true) } ?? false },
              pause: { [weak self] in self?.remoteCommand { $0.setPlaying(false) } ?? false },
              toggle: { [weak self] in self?.remoteCommand { $0.togglePlay() } ?? false },
              next: { [weak self] in self?.remoteCommand { $0.next() } ?? false },
              previous: { [weak self] in self?.remoteCommand { $0.previous() } ?? false },
              seek: { [weak self] s in self?.remoteCommand { $0.seek(to: s) } ?? false },
              like: { [weak self] want in
                  guard let self, let id = self.current?.id, let likes = self.likes else { return false }
                  if likes.isLiked(id) != want { Task { await likes.toggle(id) } }
                  if let t = self.mirrorTarget { self.link?.send(.patchLiked(itemId: id, liked: want), to: t) }
                  self.likedOverride[id] = want
                  self.reportNow(); self.updateLockScreen()
                  return true
              })
    }

    private func remoteCommand(_ f: (Player) -> Void) -> Bool {
        guard current != nil || model.current != nil else { return false }
        f(self)
        return true
    }

    // MARK: - Audio session events

    private func interruptionBegan() {
        guard mirrorTarget == nil, isPlaying else { return }
        interruptedWhilePlaying = true
        engine?.pause()
        position = positionNow()
        isPlaying = false; isLoading = false
        reportNow(); updateLockScreen(); persistPlayhead(force: true); updateTicker()
    }

    private func interruptionEnded(_ shouldResume: Bool) {
        let resume = interruptedWhilePlaying && shouldResume
        interruptedWhilePlaying = false
        if resume, mirrorTarget == nil, loadedId != nil { localSetPlaying(true) }
    }

    private func routeLost() {
        guard mirrorTarget == nil, isPlaying else { return }
        localSetPlaying(false)
    }

    private func mediaServicesReset() {
        let wasPlaying = isPlaying, pos = positionNow()
        let fresh = AVAudioOutput()
        fresh.events = self
        engine = fresh
        loadedId = nil
        if wasPlaying, model.current != nil { startLocal(model.index, at: pos, play: true) }
    }

    // MARK: - Ticker

    private func updateTicker() {
        if isPlaying {
            guard ticker == nil else { return }
            lastTickAt = now
            let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.tick() } }
            RunLoop.main.add(t, forMode: .common)
            ticker = t
        } else {
            ticker?.invalidate(); ticker = nil
            progressTick &+= 1
        }
    }

    func tick() {
        let t = now
        let dt = max(0, min(2, (t - lastTickAt) / 1000))
        lastTickAt = t
        let p = positionNow()
        if abs(p - position) > 0.01 { position = p }
        progressTick &+= 1
        if mirrorTarget == nil {
            countListen(dt)
            if t - lastHeadSave > 5000 { persistPlayhead(force: false) }
        }
    }

    // MARK: - Persistence

    private func observeAccount() {
        guard let account else { return }
        withObservationTracking {
            _ = account.user?.id; _ = account.saved?.main
        } onChange: { [weak self] in
            Task { @MainActor in self?.accountChanged(); self?.observeAccount() }
        }
        accountChanged()
    }

    private func accountChanged() {
        guard let account else { return }
        let key = account.user.map { "\(account.saved?.main ?? "")|\($0.id)" }
        guard key != accountKey else { return }
        accountKey = key
        if let key { useStore(.forAccount(key)) } else { signedOut() }
    }

    private func signedOut() {
        engine?.unload(); loadedId = nil; set(\.deliveredProfile, nil)
        startGen += 1
        store = nil
        model = PlayQueue(); modelVersion += 1
        trackCache = [:]; likedOverride = [:]
        isPlaying = false; isLoading = false; position = 0; duration = 0
        showLocal()
        lockScreen?.update(nil)
        audioSession?.deactivate()
        updateTicker()
    }

    private func useStore(_ s: PlayerPersistence) {
        store = s
        guard model.isEmpty, loadedId == nil, let saved = s.load() else { return }
        model = saved.queue; modelVersion += 1
        savedAt = saved.at
        if let v = saved.volume { volume = v; localVolume = v }
        showLocal()
        position = saved.position
        duration = model.current?.track.duration ?? 0
        isPlaying = false
        updateLockScreen()
    }

    private func persistQueue() {
        guard let store, mirrorTarget == nil else { return }
        queueSaveTask?.cancel()
        let q = model
        queueSaveTask = Task {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            store.saveQueue(q)
        }
    }

    private func playhead() -> PlayerPersistence.Playhead? {
        guard let cur = model.current else { return nil }
        return .init(trackId: cur.track.id, index: model.index, position: positionNow(),
                     repeatMode: model.repeatMode, shuffle: model.shuffle, volume: localVolumeNow, at: now)
    }

    private func persistPlayhead(force: Bool) {
        guard let store, mirrorTarget == nil, let h = playhead() else { return }
        lastHeadSave = now
        savedAt = h.at
        store.savePlayhead(h)
        if force { persistQueue() }
    }

    func flushPersistence() {
        guard let store, mirrorTarget == nil else { return }
        queueSaveTask?.cancel()
        let h = playhead()
        if let h { savedAt = h.at }
        store.flush(model, h)
    }

    // MARK: - Helpers

    @discardableResult
    private func mutate<T>(_ f: (inout PlayQueue) -> T) -> T {
        let r = f(&model)
        modelVersion += 1
        return r
    }

    /// Public state from the local model (not while mirroring).
    private func showLocal() {
        guard mirrorTarget == nil else { return }
        if shownVersion != modelVersion {
            shownVersion = modelVersion
            let tracks = model.tracks
            if tracks != queue { queue = tracks }
            let flags = model.entries.map(\.queued)
            if flags != queuedFlags { queuedFlags = flags }
            let recs = model.entries.map(\.rec)
            if recs != recFlags { recFlags = recs }
        }
        set(\.index, model.index)
        set(\.repeatMode, model.repeatMode)
        set(\.shuffle, model.shuffle)
        set(\.context, model.context)
        if remoteClientId != nil { remoteClientId = nil }
        if output.id != "local" { output = .local("This Phone") }
    }

    /// Observation notifies on every set; skip equal values so SwiftUI is not re-rendered.
    private func set<V: Equatable>(_ kp: ReferenceWritableKeyPath<Player, V>, _ v: V) {
        if self[keyPath: kp] != v { self[keyPath: kp] = v }
    }

    private func clampPos(_ p: Double, _ dur: Double?) -> Double {
        guard let d = dur, d > 0 else { return max(0, p) }
        return max(0, min(p, d))
    }
}

// MARK: - Engine events

extension Player: AudioEngineEvents {
    func audioHeard(_ id: String) {
        guard id == loadedId, id == model.current?.track.id else { return }
        let first = !heard
        if first { heardAt = now }
        heard = true
        if isLoading { isLoading = false }
        position = positionNow()
        reportNow(); updateLockScreen()
        if first { warmAhead() }
    }

    func audioWaiting(_ id: String) {
        guard id == loadedId, isPlaying, !isLoading else { return }
        isLoading = true
        reportNow(); updateLockScreen()
    }

    func audioEnded(_ id: String) {
        guard id == loadedId, id == model.current?.track.id else { return }
        advance(auto: true)
    }

    func audioAdvanced(to id: String) {
        guard let ni = preparedNextIndex, model.entries.indices.contains(ni), model.entries[ni].track.id == id else {
            // The queue moved under a preloaded song: play what the queue says now.
            advance(auto: true)
            return
        }
        preparedNextIndex = nil
        model.index = ni
        let track = model.entries[ni].track
        loadedId = id
        set(\.deliveredProfile, Self.delivered(audioItem(for: track)))
        startGen += 1
        heard = true
        heardAt = now
        showLocal()
        position = 0
        duration = track.duration
        isLoading = false
        newListen(id)
        prepareNext()
        reportNow(); updateLockScreen(); persistPlayhead(force: false)
        warmAhead()
        extendEarly()
    }

    func audioFailed(_ id: String, message: String) {
        guard id == loadedId else { return }
        error = message
        isPlaying = false; isLoading = false
        reportNow(); updateLockScreen(); updateTicker()
    }

    func audioDuration(_ id: String, seconds: Double) {
        guard id == loadedId, abs(seconds - duration) > 0.5 else { return }
        duration = seconds
        updateLockScreen()
    }

    func audioStarved(_ id: String) { linkWatch?.noteStarve() }

    /// Built again from the backend, so a retry follows the address the app uses now (a song
    /// started at home keeps going on the main address once home is gone).
    func audioItemForRetry(_ item: AudioItem) -> AudioItem {
        guard let track = model.entries.first(where: { $0.track.id == item.id })?.track else { return item }
        let fresh = audioItem(for: track)
        if item.id == loadedId { set(\.deliveredProfile, Self.delivered(fresh)) }
        return fresh
    }
}

/// Seedable RNG so shuffle tests are deterministic.
struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64 = UInt64.random(in: .min ... .max)) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
