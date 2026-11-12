import AVFoundation

/// AudioEngine on AVFoundation. Two AVQueuePlayers: the active one, and an idle one that
/// buffers the next song (crossfade, or gapless off) or fades out during a crossfade.
/// Gapless: the next song is queued behind the current one on the active AVQueuePlayer,
/// which hands over without a gap by itself.
@MainActor
final class AVAudioOutput: NSObject, AudioEngine {
    weak var events: AudioEngineEvents?

    /// Main-actor only; Sendable so the KVO closures can hand it back to the main actor.
    private final class Slot: @unchecked Sendable {
        let player = AVQueuePlayer()
        var item: AudioItem?
        var av: AVPlayerItem?
        /// Gapless follower queued behind `av`.
        var next: (item: AudioItem, av: AVPlayerItem)?
        var observers: [NSKeyValueObservation] = []
        var timeObserver: Any?
    }

    private struct Fade {
        var from: Slot
        var to: Slot
        var start: Date
        var length: Double
        var timer: Timer
    }

    private var active = Slot()
    private var idle = Slot()
    private var transition: AudioTransition = .none
    private var userVolume: Float = 1
    private var wantPlaying = false
    private var pendingSeek: Double?
    private var fade: Fade?
    /// setNext while a crossfade still uses the idle player: applied when it ends.
    private var deferredNext: (AudioItem?, AudioTransition)?
    private var itemObservers: [ObjectIdentifier: [NSKeyValueObservation]] = [:]
    private var notes: [NSObjectProtocol] = []
    private var retries = 0
    private var retryTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var lastTime: Double = 0

    /// A song stuck with nothing coming for this long is reloaded (web STUCK_NO_DATA_MS).
    static let stuckAfter: Double = 30
    static let maxRetries = 5

    override init() {
        super.init()
        for s in [active, idle] { setUp(s) }
        let nc = NotificationCenter.default
        notes.append(nc.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] n in
            let item = n.object as? AVPlayerItem
            MainActor.assumeIsolated { if let item { self?.itemEnded(item) } }
        })
        notes.append(nc.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] n in
            let item = n.object as? AVPlayerItem
            let err = n.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            MainActor.assumeIsolated { if let item { self?.itemFailed(item, err) } }
        })
        notes.append(nc.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: nil, queue: .main) { [weak self] n in
            let item = n.object as? AVPlayerItem
            MainActor.assumeIsolated {
                guard let self, let item, item === self.active.av, let id = self.active.item?.id else { return }
                self.events?.audioStarved(id)
            }
        })
    }

    private func setUp(_ s: Slot) {
        s.player.automaticallyWaitsToMinimizeStalling = true
        s.player.actionAtItemEnd = .advance
        s.observers.append(s.player.observe(\.timeControlStatus, options: [.new]) { [weak self, weak s] _, _ in
            Task { @MainActor in if let self, let s { self.statusChanged(s) } }
        })
        s.observers.append(s.player.observe(\.currentItem, options: [.new]) { [weak self, weak s] _, _ in
            Task { @MainActor in if let self, let s { self.currentItemChanged(s) } }
        })
        s.timeObserver = s.player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self, weak s] _ in
            MainActor.assumeIsolated { if let self, let s { self.tick(s) } }
        }
    }

    // MARK: AudioEngine

    var currentId: String? { active.item?.id }

    var currentTime: Double {
        if let p = pendingSeek { return p }
        let t = active.player.currentTime().seconds
        return t.isFinite ? max(0, t) : lastTime
    }

    func load(_ item: AudioItem, at seconds: Double, play: Bool) {
        finishFade()
        retryTask?.cancel(); retryTask = nil
        if active.item?.id != item.id { retries = 0 }
        wantPlaying = play
        if idle.item?.id == item.id, let st = idle.av?.status, st != .failed {
            // The spare already buffers it: swap roles, no new request.
            let old = active; active = idle; idle = old
            active.item = item
            clear(idle)
        } else if let n = active.next, n.item.id == item.id, n.av.status != .failed {
            active.player.advanceToNextItem()
            active.item = n.item; active.av = n.av; active.next = nil
        } else {
            clear(active)
            let av = makeItem(item)
            active.item = item; active.av = av
            active.player.insert(av, after: nil)
        }
        lastTime = seconds
        pendingSeek = seconds > 0.05 ? seconds : nil
        applyVolume()
        if pendingSeek != nil { seekWhenReady() } else if play { active.player.play() } else { active.player.pause() }
    }

    func setNext(_ item: AudioItem?, transition t: AudioTransition) {
        if fade != nil { deferredNext = (item, t); return }
        transition = t
        guard let item else { removeNext(active); clear(idle); return }
        if t == .gapless {
            clear(idle)
            if active.next?.item.id == item.id, active.next?.av.status != .failed { return }
            removeNext(active)
            guard let cur = active.av else { return }
            let av = makeItem(item)
            if active.player.canInsert(av, after: cur) {
                active.player.insert(av, after: cur)
                active.next = (item, av)
            } else {
                forget(av)
            }
        } else {
            removeNext(active)
            if idle.item?.id == item.id, idle.av?.status != .failed { return }
            clear(idle)
            let av = makeItem(item)
            idle.item = item; idle.av = av
            idle.player.volume = 0
            idle.player.insert(av, after: nil)
            idle.player.pause()
        }
    }

    func play() {
        wantPlaying = true
        guard active.av != nil else { return }
        if pendingSeek != nil { seekWhenReady(); return }
        active.player.play()
    }

    func pause() {
        wantPlaying = false
        finishFade()
        active.player.pause()
        watchdog?.cancel(); watchdog = nil
    }

    func seek(to seconds: Double) {
        finishFade()
        lastTime = seconds
        pendingSeek = seconds
        seekWhenReady()
    }

    func setVolume(_ v: Float) {
        userVolume = max(0, min(1, v))
        if fade == nil { applyVolume() }
    }

    func unload() {
        wantPlaying = false
        finishFade()
        retryTask?.cancel(); retryTask = nil
        watchdog?.cancel(); watchdog = nil
        pendingSeek = nil
        clear(active); clear(idle)
        transition = .none
    }

    // MARK: internals

    private func makeItem(_ item: AudioItem) -> AVPlayerItem {
        let av = AVPlayerItem(asset: AVURLAsset(url: item.url))
        let id = ObjectIdentifier(av)
        itemObservers[id] = [
            av.observe(\.status, options: [.new]) { [weak self, weak av] _, _ in
                Task { @MainActor in if let self, let av { self.itemStatusChanged(av) } }
            },
            av.observe(\.duration, options: [.new]) { [weak self, weak av] _, _ in
                Task { @MainActor in if let self, let av { self.itemDurationChanged(av) } }
            },
        ]
        return av
    }

    private func forget(_ av: AVPlayerItem) {
        itemObservers[ObjectIdentifier(av)]?.forEach { $0.invalidate() }
        itemObservers[ObjectIdentifier(av)] = nil
    }

    private func clear(_ s: Slot) {
        s.player.pause()
        s.player.removeAllItems()
        if let av = s.av { forget(av) }
        if let n = s.next { forget(n.av) }
        s.item = nil; s.av = nil; s.next = nil
    }

    private func removeNext(_ s: Slot) {
        guard let n = s.next else { return }
        s.player.remove(n.av)
        forget(n.av)
        s.next = nil
    }

    private func applyVolume() {
        active.player.volume = userVolume * (active.item?.gain ?? 1)
    }

    private func seekWhenReady() {
        guard let av = active.av, let target = pendingSeek else { return }
        guard av.status == .readyToPlay else { return }   // itemStatusChanged retries
        let id = active.item?.id
        active.player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.active.item?.id == id, self.pendingSeek == target else { return }
                self.pendingSeek = nil
                if self.wantPlaying { self.active.player.play() } else { self.active.player.pause() }
            }
        }
    }

    private func statusChanged(_ s: Slot) {
        guard s === active, let id = s.item?.id else { return }
        switch s.player.timeControlStatus {
        case .playing:
            watchdog?.cancel(); watchdog = nil
            if retries > 0, s.player.currentTime().seconds > lastTime + 1 { retries = 0 }
            events?.audioHeard(id)
        case .waitingToPlayAtSpecifiedRate:
            events?.audioWaiting(id)
            armWatchdog(id)
        case .paused:
            break
        @unknown default:
            break
        }
    }

    /// Segments may block up to 30 s server-side; that is waiting, not failure. Past it
    /// with nothing playing, reload at the playhead.
    private func armWatchdog(_ id: String) {
        guard watchdog == nil else { return }
        let at = currentTime
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.stuckAfter))
            guard !Task.isCancelled, let self else { return }
            self.watchdog = nil
            guard self.wantPlaying, self.active.item?.id == id, self.active.player.timeControlStatus != .playing else { return }
            self.events?.audioStarved(id)
            self.reload(at: max(at, self.currentTime))
        }
    }

    private func currentItemChanged(_ s: Slot) {
        guard s === active, let n = s.next, s.player.currentItem === n.av else { return }
        if let old = s.av { forget(old) }
        s.item = n.item; s.av = n.av; s.next = nil
        retries = 0
        lastTime = 0
        applyVolume()
        events?.audioAdvanced(to: n.item.id)
    }

    private func tick(_ s: Slot) {
        guard s === active else { return }
        let t = s.player.currentTime().seconds
        if t.isFinite, pendingSeek == nil { lastTime = t }
        guard case .crossfade(let length) = transition, fade == nil, wantPlaying,
              idle.item != nil, let av = active.av, s.player.timeControlStatus == .playing else { return }
        let own = av.duration.seconds
        let dur = own.isFinite && own > 0 ? own : (active.item?.duration ?? 0)
        let left = dur - t
        if dur > 0, left <= length, left > 0.1 { beginFade(length: left) }
    }

    private func beginFade(length: Double) {
        let from = active, to = idle
        active = to; idle = from
        to.player.volume = 0
        to.player.play()
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.fadeStep() }
        }
        RunLoop.main.add(timer, forMode: .common)
        fade = Fade(from: from, to: to, start: Date(), length: length, timer: timer)
        retries = 0
        lastTime = 0
        if let id = to.item?.id { events?.audioAdvanced(to: id) }
    }

    private func fadeStep() {
        guard let f = fade else { return }
        let x = min(1, Date().timeIntervalSince(f.start) / max(0.05, f.length))
        f.from.player.volume = Float(cos(x * .pi / 2)) * userVolume * (f.from.item?.gain ?? 1)
        f.to.player.volume = Float(sin(x * .pi / 2)) * userVolume * (f.to.item?.gain ?? 1)
        if x >= 1 { finishFade() }
    }

    /// Ends a crossfade now: the outgoing song stops, the incoming one at full level.
    private func finishFade() {
        guard let f = fade else { return }
        f.timer.invalidate()
        fade = nil
        clear(f.from)
        applyVolume()
        if let (item, t) = deferredNext { deferredNext = nil; setNext(item, transition: t) }
    }

    private func itemEnded(_ av: AVPlayerItem) {
        guard av === active.av, let id = active.item?.id else { return }
        if active.next != nil { return }   // gapless: currentItemChanged takes it
        if fade != nil { return }
        watchdog?.cancel(); watchdog = nil
        wantPlaying = false
        events?.audioEnded(id)
    }

    private func itemStatusChanged(_ av: AVPlayerItem) {
        if av === active.av {
            if av.status == .readyToPlay {
                if pendingSeek != nil { seekWhenReady() }
            } else if av.status == .failed {
                itemFailed(av, av.error)
            }
        } else if av.status == .failed {
            // A preload failed: drop it; a real start makes a fresh request.
            if av === idle.av { clear(idle) } else if av === active.next?.av { removeNext(active) }
        }
    }

    private func itemDurationChanged(_ av: AVPlayerItem) {
        guard av === active.av, let id = active.item?.id else { return }
        let d = av.duration.seconds
        if d.isFinite, d > 0 { events?.audioDuration(id, seconds: d) }
    }

    /// 503 busy, a slow transcode, a dropped link: retry with backoff before giving up.
    private func itemFailed(_ av: AVPlayerItem, _ error: Error?) {
        guard av === active.av, let id = active.item?.id else {
            if av === idle.av { clear(idle) } else if av === active.next?.av { removeNext(active) }
            return
        }
        guard retries < Self.maxRetries else {
            events?.audioFailed(id, message: error?.localizedDescription ?? "playback failed")
            return
        }
        retries += 1
        let delay = min(8.0, pow(2, Double(retries - 1)))
        events?.audioWaiting(id)
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.active.item?.id == id else { return }
            self.reload(at: self.lastTime)
        }
    }

    private func reload(at seconds: Double) {
        guard let old = active.item else { return }
        let item = events?.audioItemForRetry(old) ?? old
        let keep = retries, play = wantPlaying
        let next = active.next.map { events?.audioItemForRetry($0.item) ?? $0.item }, t = transition
        clear(active)
        let av = makeItem(item)
        active.item = item; active.av = av
        active.player.insert(av, after: nil)
        retries = keep
        pendingSeek = seconds > 0.05 ? seconds : nil
        wantPlaying = play
        applyVolume()
        if pendingSeek != nil { seekWhenReady() } else if play { active.player.play() }
        if t == .gapless, let next { setNext(next, transition: t) }
    }
}
