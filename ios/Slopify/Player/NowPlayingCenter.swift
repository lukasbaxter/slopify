import MediaPlayer
import UIKit

/// What the lock screen / Control Center / AirPods show.
struct LockScreenInfo: Equatable {
    var id: String
    var title: String
    var artist: String
    var album: String
    var duration: Double
    var elapsed: Double
    /// 1 while sound is coming out, 0 paused or buffering (iOS runs the clock from this).
    var rate: Double
    var index: Int
    var count: Int
    var liked: Bool
    /// Image id for /api/image/:id (track id; the server serves its album cover).
    var artId: String
}

@MainActor
protocol NowPlayingPublishing: AnyObject {
    func update(_ info: LockScreenInfo?)
}

/// MPNowPlayingInfoCenter + MPRemoteCommandCenter.
@MainActor
final class NowPlayingCenter: NowPlayingPublishing {
    struct Handlers {
        var play: () -> Bool
        var pause: () -> Bool
        var toggle: () -> Bool
        var next: () -> Bool
        var previous: () -> Bool
        var seek: (Double) -> Bool
        var like: (Bool) -> Bool
    }

    private let artwork: (String) async -> Data?
    private var last: LockScreenInfo?
    private var art: (id: String, art: MPMediaItemArtwork)?
    private var artTask: Task<Void, Never>?

    init(handlers: Handlers, artwork: @escaping (String) async -> Data?) {
        self.artwork = artwork
        let c = MPRemoteCommandCenter.shared()
        func bind(_ cmd: MPRemoteCommand, _ f: @escaping () -> Bool) {
            cmd.isEnabled = true
            cmd.addTarget { _ in onMain { f() ? .success : .noActionableNowPlayingItem } }
        }
        bind(c.playCommand, handlers.play)
        bind(c.pauseCommand, handlers.pause)
        bind(c.togglePlayPauseCommand, handlers.toggle)
        bind(c.nextTrackCommand, handlers.next)
        bind(c.previousTrackCommand, handlers.previous)
        c.changePlaybackPositionCommand.isEnabled = true
        c.changePlaybackPositionCommand.addTarget { e in
            let pos = (e as? MPChangePlaybackPositionCommandEvent)?.positionTime
            return onMain { pos.map(handlers.seek) == true ? .success : .commandFailed }
        }
        c.likeCommand.isEnabled = true
        c.likeCommand.addTarget { e in
            let negative = (e as? MPFeedbackCommandEvent)?.isNegative ?? false
            return onMain { handlers.like(!negative) ? .success : .commandFailed }
        }
        for cmd in [c.skipForwardCommand, c.skipBackwardCommand, c.seekForwardCommand, c.seekBackwardCommand,
                    c.dislikeCommand, c.bookmarkCommand, c.changeRepeatModeCommand, c.changeShuffleModeCommand] {
            cmd.isEnabled = false
        }
    }

    func update(_ info: LockScreenInfo?) {
        guard info != last else { return }
        last = info
        let center = MPNowPlayingInfoCenter.default()
        guard let info else {
            center.nowPlayingInfo = nil
            artTask?.cancel(); artTask = nil
            return
        }
        MPRemoteCommandCenter.shared().likeCommand.isActive = info.liked
        var d: [String: Any] = [
            MPMediaItemPropertyTitle: info.title,
            MPMediaItemPropertyArtist: info.artist,
            MPMediaItemPropertyAlbumTitle: info.album,
            MPMediaItemPropertyPlaybackDuration: info.duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: info.elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: info.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
            MPNowPlayingInfoPropertyPlaybackQueueIndex: info.index,
            MPNowPlayingInfoPropertyPlaybackQueueCount: info.count,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyExternalContentIdentifier: info.id,
        ]
        if let a = art, a.id == info.artId { d[MPMediaItemPropertyArtwork] = a.art }
        center.nowPlayingInfo = d
        if art?.id != info.artId { loadArt(info.artId) }
    }

    private func loadArt(_ id: String) {
        artTask?.cancel()
        artTask = Task { [weak self] in
            guard let self, let data = await self.artwork(id), !Task.isCancelled,
                  let image = UIImage(data: data) else { return }
            let a = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.art = (id, a)
            if self.last?.artId == id, var d = MPNowPlayingInfoCenter.default().nowPlayingInfo {
                d[MPMediaItemPropertyArtwork] = a
                MPNowPlayingInfoCenter.default().nowPlayingInfo = d
            }
        }
    }
}

/// Remote command handlers come on the main thread in practice; hop there if not.
private func onMain<T: Sendable>(_ f: @MainActor () -> T) -> T {
    if Thread.isMainThread { return MainActor.assumeIsolated(f) }
    return DispatchQueue.main.sync { MainActor.assumeIsolated(f) }
}
