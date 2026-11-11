import SwiftUI

/// What the player screens read from the player and the session together.
@MainActor
struct NowPlayingSession {
    let player: Player
    let session: SessionClient

    var devices: [NowPlayingDevice] { NowPlayingDevices.devices(players: session.players, lan: session.lanDevices) }

    /// The device the session is on (Player.jsx `sessionDeviceOf`).
    var active: NowPlayingDevice {
        NowPlayingDevices.sessionDevice(activeId: session.activeClientId, myId: session.clientId, players: session.players, devices: devices)
    }

    /// Green state: the session is not on this phone.
    var casting: Bool { active.kind != "local" }

    /// "Playing on {name}" target, nil when the sound is here.
    var elsewhere: String? { NowPlayingDevices.elsewhereLabel(activeId: session.activeClientId, myId: session.clientId, players: session.players) }

    /// Mirroring another client (`player.mirroring`).
    var mirroring: Bool { player.remoteClientId != nil }

    /// Calibrated output delay of the session's speaker, seconds (`useOffset`).
    var speakerDelay: Double {
        guard let id = activeSpeakerId else { return 0 }
        return session.offsets[id] ?? 0
    }

    private var activeSpeakerId: String? {
        guard let a = session.activeClientId, a != session.clientId,
              let d = session.players.first(where: { $0.id == a })?.nowPlaying?.device, NowPlayingDevices.isSpeaker(d) else { return nil }
        return d.id
    }

    /// The quality line (QualityBadge.jsx `deliveredFormat`): speakers and other clients get the
    /// original; this phone what the stream profile delivers.
    func deliveredFormat(_ track: Track?) -> Format? {
        guard let track else { return nil }
        if casting { return DeliveredFormat.delivered(track.format, deviceKind: active.kind) }
        let live = track.id == player.current?.id ? player.deliveredProfile : nil
        switch live ?? Player.delivered(player.audioItem(for: track)) {
        case .file?: return DeliveredFormat.delivered(track.format, deviceKind: "local", mode: .file)
        case .hls(let p)?: return DeliveredFormat.delivered(track.format, deviceKind: "local", mode: .hls, profile: p)
        case nil: return DeliveredFormat.delivered(track.format, deviceKind: "local", mode: .hls)
        }
    }
}

enum NowPlayingCover {
    /// A track's cover. Mirrored tracks may lack an album id: fall back to the track's own picture.
    static func source(_ t: Track) -> CoverSource {
        .track(id: t.id, albumId: t.albumId.isEmpty ? nil : t.albumId, art: t.cover)
    }
}

extension Player.Shuffle {
    var nowPlayingGlyph: ShuffleGlyph.Mode { ShuffleGlyph.Mode(rawValue: rawValue) ?? .off }
    /// off -> on -> smart -> off (usePlayer.js:1382-1394).
    var nowPlayingNext: Player.Shuffle { self == .off ? .on : self == .on ? .smart : .off }
}

extension Player.Repeat {
    var nowPlayingGlyph: RepeatGlyph.Mode { RepeatGlyph.Mode(rawValue: rawValue) ?? .off }
    /// off -> all -> one -> off.
    var nowPlayingNext: Player.Repeat { self == .off ? .all : self == .all ? .one : .off }
}

/// `NowPlayingArtistLinks` (TrackRow.jsx:82-103): each artist its own tappable name, ", " between.
struct NowPlayingArtistLinks: View {
    let track: Track
    var onArtist: (String) -> Void

    var body: some View {
        let credits = track.artistCredits
        if credits.isEmpty || credits.allSatisfy({ $0.id == nil }) {
            let fallback = track.artist.isEmpty ? track.albumArtist : track.artist
            Text(fallback).lineLimit(1)
                .onTapGesture { if let id = track.artistIds.first { onArtist(id) } }
        } else {
            HStack(spacing: 0) {
                ForEach(Array(credits.enumerated()), id: \.offset) { i, c in
                    Text(c.name).lineLimit(1)
                        .onTapGesture { if let id = c.id { onArtist(id) } }
                    if i < credits.count - 1 { Text(verbatim: ", ") }
                }
            }
            .lineLimit(1)
            .truncationMode(.tail)
        }
    }
}

/// Liking from the player (App.jsx:1013-1027): flip, then toast the result.
@MainActor
enum NowPlayingLike {
    static func toggle(_ id: String, likes: Likes) async {
        let want = !likes.isLiked(id)
        do {
            try await likes.set(id, liked: want)
            ToastCenter.shared.show(want ? L("Added to Liked Songs") : L("Removed from Liked Songs"))
        } catch {
            ToastCenter.shared.show(L("Not saved: {error}", ["error": error.localizedDescription]))
        }
    }
}
