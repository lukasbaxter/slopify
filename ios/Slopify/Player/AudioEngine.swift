import Foundation

/// One song as the audio layer sees it.
struct AudioItem: Equatable, Sendable {
    var id: String
    var url: URL
    /// Linear gain the player applies itself (<= 1), on top of the user volume.
    var gain: Float = 1
    /// Library length, used until the stream reports its own.
    var duration: Double = 0
}

/// How the current song hands over to the preloaded next one when it ends by itself.
enum AudioTransition: Equatable, Sendable {
    /// Next is only buffered; the Player starts it after `ended` (sleep timer, repeat one, gapless off).
    case none
    /// Next starts the moment this one ends (AVQueuePlayer).
    case gapless
    /// Next starts this many seconds before the end, equal-power fade.
    case crossfade(Double)
}

/// What the Player needs from AVFoundation. Behind a protocol so queue / session logic is
/// testable with a fake.
@MainActor
protocol AudioEngine: AnyObject {
    var events: AudioEngineEvents? { get set }
    var currentId: String? { get }
    /// Seconds into the current song.
    var currentTime: Double { get }
    /// Replace everything and start `item` at `seconds` (uses a preloaded copy when it has one).
    func load(_ item: AudioItem, at seconds: Double, play: Bool)
    /// What comes after the current song, and how it takes over. nil clears.
    func setNext(_ item: AudioItem?, transition: AudioTransition)
    func play()
    func pause()
    func seek(to seconds: Double)
    /// User volume 0...1.
    func setVolume(_ v: Float)
    /// Stop and drop all media (yield, hand-off, end of queue).
    func unload()
}

@MainActor
protocol AudioEngineEvents: AnyObject {
    /// Sound is coming out (after a load, seek or rebuffer).
    func audioHeard(_ id: String)
    /// Playing but waiting for data.
    func audioWaiting(_ id: String)
    /// Ended with nothing taking over: the Player decides what is next.
    func audioEnded(_ id: String)
    /// The preloaded next song took over by itself (gapless / crossfade).
    func audioAdvanced(to id: String)
    /// Gave up after retries.
    func audioFailed(_ id: String, message: String)
    /// The stream's own length is known.
    func audioDuration(_ id: String, seconds: Double)
    /// A stall worth noting for the cellular quality cap.
    func audioStarved(_ id: String)
    /// A failed or stuck song is about to be loaded again: what to load. The address in use
    /// may have moved since the song started (home lost, now on main, API.md §4.4), so a retry
    /// must not go back to the dead one.
    func audioItemForRetry(_ item: AudioItem) -> AudioItem
}

extension AudioEngineEvents {
    func audioItemForRetry(_ item: AudioItem) -> AudioItem { item }
}
