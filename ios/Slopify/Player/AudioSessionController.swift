import AVFoundation

@MainActor
protocol AudioSessionControlling: AnyObject {
    var onInterruptionBegan: (() -> Void)? { get set }
    /// `shouldResume`: the system says resuming is appropriate (call ended, Siri done).
    var onInterruptionEnded: ((_ shouldResume: Bool) -> Void)? { get set }
    /// Headphones / AirPods taken out: music pauses (Apple HIG).
    var onRouteLost: (() -> Void)? { get set }
    var onMediaServicesReset: (() -> Void)? { get set }
    /// Seconds from output to the speaker (AVAudioSession.outputLatency).
    var outputLatency: Double { get }
    func activate()
    func deactivate()
}

/// AVAudioSession: .playback (background audio; the app has UIBackgroundModes audio),
/// interruptions and route changes.
@MainActor
final class AudioSessionController: AudioSessionControlling {
    var onInterruptionBegan: (() -> Void)?
    var onInterruptionEnded: ((Bool) -> Void)?
    var onRouteLost: (() -> Void)?
    var onMediaServicesReset: (() -> Void)?
    private var notes: [NSObjectProtocol] = []
    private var active = false
    var outputLatency: Double { AVAudioSession.sharedInstance().outputLatency }

    init() {
        configure()
        let nc = NotificationCenter.default
        let s = AVAudioSession.sharedInstance()
        notes.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: s, queue: .main) { [weak self] n in
            let info = n.userInfo ?? [:]
            let type = (info[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            let opts = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated {
                guard let self else { return }
                switch type {
                case .began:
                    self.onInterruptionBegan?()
                case .ended:
                    self.active = false
                    self.onInterruptionEnded?(opts.contains(.shouldResume))
                default: break
                }
            }
        })
        notes.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: s, queue: .main) { [weak self] n in
            let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            MainActor.assumeIsolated {
                if raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable { self?.onRouteLost?() }
            }
        })
        notes.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: s, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.active = false
                self?.configure()
                self?.onMediaServicesReset?()
            }
        })
    }

    private func configure() {
        // longFormAudio: music, routes like Music.app (AirPlay 2 picks the whole route).
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
    }

    func activate() {
        guard !active else { return }
        do { try AVAudioSession.sharedInstance().setActive(true); active = true } catch { active = false }
    }

    func deactivate() {
        guard active else { return }
        active = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
