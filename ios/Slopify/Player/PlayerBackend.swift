import Foundation

/// The REST side the Player uses. APIClient conforms; tests use a fake.
@MainActor
protocol PlayerBackend: AnyObject {
    var token: String? { get }
    func tracks(ids: [String]) async throws -> [Track]
    func mix(_ id: String, limit: Int?, mode: String?) async throws -> Mix
    func artist(_ id: String) async throws -> ArtistDetail
    func warm(ids: [String], profile: String, norm: String?) async throws
    func postPlay(trackId: String, at: Double?, client: String) async throws
    func hlsURL(trackId: String, max: String, norm: String?) -> URL
    func imageURL(id: String, size: Int, banner: Bool, bust: String?) -> URL
    /// Cover bytes for the lock screen.
    func imageData(id: String, size: Int) async -> Data?
    /// Fetch the start rung of a song's HLS stream (low priority) so a press of play finds it
    /// transcoded. Failures are ignored.
    func prewarm(master: URL) async
}

extension APIClient: PlayerBackend {
    func imageData(id: String, size: Int) async -> Data? {
        var req = URLRequest(url: imageURL(id: id, size: size))
        req.setValue("image/webp,image/jpeg", forHTTPHeaderField: "Accept")
        guard let (data, resp) = try? await session.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return nil }
        return data
    }

    /// slopify.js `prewarm`: the master names the start rung first (with any baked gain); its
    /// playlist is asked for with `pre=1` (a warm, not a play), retried while still encoding,
    /// then its init segment and first two segments.
    func prewarm(master: URL) async {
        func text(_ u: URL) async -> String? {
            guard let (d, r) = try? await session.data(from: u), (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return String(data: d, encoding: .utf8)
        }
        guard let m = await text(master), let first = HLSPlaylist.variants(m).first,
              var c = URLComponents(url: URL(string: first, relativeTo: master)?.absoluteURL ?? master, resolvingAgainstBaseURL: false) else { return }
        c.queryItems = (c.queryItems ?? []).filter { $0.name != "abr" } + [URLQueryItem(name: "pre", value: "1")]
        guard let variant = c.url else { return }
        for attempt in 0..<4 {
            guard let pl = await text(variant) else { return }
            if pl.contains("#EXT-X-ENDLIST") {
                for seg in HLSPlaylist.segments(pl, count: 2) {
                    if let u = URL(string: seg, relativeTo: variant) { _ = try? await session.data(from: u) }
                }
                return
            }
            if attempt < 3 { try? await Task.sleep(for: .milliseconds(2500)) }
        }
    }
}

/// Just enough HLS playlist reading for prewarm.
enum HLSPlaylist {
    /// Variant URIs of a master playlist, in order.
    static func variants(_ master: String) -> [String] {
        lines(master).filter { !$0.hasPrefix("#") }
    }

    /// The init segment (fMP4) and the first `count` media segments of a variant playlist.
    static func segments(_ playlist: String, count: Int) -> [String] {
        let ls = lines(playlist)
        var out: [String] = []
        if let map = ls.first(where: { $0.hasPrefix("#EXT-X-MAP:") }),
           let r = map.range(of: #"URI="([^"]+)""#, options: .regularExpression) {
            out.append(String(map[r].dropFirst(5).dropLast()))
        }
        out += ls.filter { $0.range(of: #"^s\d+\.(ts|m4s)(\?\S*)?$"#, options: .regularExpression) != nil }.prefix(count)
        return out
    }

    private static func lines(_ s: String) -> [String] {
        s.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// The socket side the Player uses (SessionClient's public surface). Tests use a fake.
@MainActor
protocol PlayerSessionLink: AnyObject {
    var connection: SessionClient.Connection { get }
    var clientId: String { get }
    var players: [RosterPlayer] { get }
    var activeClientId: String? { get }
    var queues: [String: [QueueItem]] { get }
    var lastSession: (nowPlaying: NowPlaying, queue: [QueueItem], at: Double)? { get }
    var sleep: (at: Double?, endOfTrack: Bool)? { get }
    var onCommand: ((Command, _ from: String) -> Void)? { get set }
    func claim()
    func report(_ np: NowPlaying?)
    func publishQueue(_ queue: [QueueItem])
    func send(_ command: Command, to clientId: String)
    func sleepDone()
    func playhead(_ np: NowPlaying) -> Double
}

extension SessionClient: PlayerSessionLink {}

extension Track {
    /// A playable Track from a socket queue item (mirrors, transfers, session adoption).
    /// Missing: cover hash / format; a later `api.tracks(ids:)` fills them in.
    init(item q: QueueItem) {
        let names = q.Artists ?? q.ArtistItems?.map(\.Name) ?? []
        let ids = q.ArtistItems?.compactMap(\.Id) ?? []
        self.init(id: q.Id, title: q.Name ?? "", artist: names.joined(separator: ", "), artists: names, artistIds: ids,
                  albumId: q.AlbumId ?? "", album: q.Album ?? "", albumArtist: q.AlbumArtist ?? names.first ?? "",
                  trackNo: nil, discNo: nil, year: nil, genres: nil,
                  durationMs: Int((q.RunTimeTicks ?? 0) / 10_000), codec: nil, bitrate: nil, cover: nil,
                  format: nil, gain: q._gain, addedAt: nil, plays: nil)
    }

    /// The only thing a session snapshot may carry: a NowPlaying (web `applySession` fallback).
    init(nowPlaying np: NowPlaying) {
        let names = np.artists?.map(\.Name) ?? (np.artist.isEmpty ? [] : [np.artist])
        self.init(id: np.itemId, title: np.title, artist: np.artist, artists: names,
                  artistIds: np.artists?.compactMap(\.Id) ?? np.artistId.map { [$0] } ?? [],
                  albumId: np.albumId ?? "", album: np.album ?? "", albumArtist: names.first ?? np.artist,
                  trackNo: nil, discNo: nil, year: nil, genres: nil,
                  durationMs: Int((np.duration ?? 0) * 1000), codec: nil, bitrate: nil, cover: nil,
                  format: nil, gain: nil, addedAt: nil, plays: nil)
    }

    /// Joined credit as the web reports it (`Artists.join(', ') || AlbumArtist`).
    var creditLine: String { artists.isEmpty ? (artist.isEmpty ? albumArtist : artist) : artists.joined(separator: ", ") }
}

/// Pure builders for what goes on the socket (API.md §20.5).
enum SessionReports {
    struct LocalState {
        var track: Track
        var index: Int
        var playing: Bool
        var held: Bool
        var position: Double
        var duration: Double
        var volume: Double
        var repeatMode: Player.Repeat
        var shuffle: Player.Shuffle
        var liked: Bool
        var device: OutputDevice
        var artUrl: String?
        var now: Double
    }

    static func nowPlaying(_ s: LocalState) -> NowPlaying {
        let t = s.track
        let credits = t.artistCredits.map { NameId(Id: $0.id, Name: $0.name) }
        return NowPlaying(itemId: t.id, title: t.title, artist: t.creditLine, album: t.album.isEmpty ? nil : t.album,
                          artUrl: s.artUrl, albumId: t.albumId.isEmpty ? nil : t.albumId, artistId: t.artistIds.first,
                          artists: credits.isEmpty ? [NameId(Id: t.artistIds.first, Name: t.albumArtist)] : credits,
                          liked: s.liked, device: s.device, queueIndex: s.index, playing: s.playing, held: s.playing && s.held,
                          position: max(0, s.position), duration: s.duration, volume: s.volume,
                          repeat: s.repeatMode.rawValue, shuffle: s.shuffle.rawValue, at: s.now, serverAt: nil)
    }

    /// Index into a published queue for a NowPlaying (§20.6: trust `queueIndex` only when it
    /// points at `itemId`).
    static func queueIndex(_ np: NowPlaying, in q: [QueueItem]) -> Int? {
        if let qi = np.queueIndex, q.indices.contains(qi), q[qi].Id == np.itemId { return qi }
        return nil
    }

    /// Where a take-over starts (§20.6 "Taking over onto this device").
    static func takeOver(_ np: NowPlaying, queue q: [QueueItem]) -> (ids: [String], index: Int, queued: [Bool]?) {
        if let qi = queueIndex(np, in: q) { return (q.map(\.Id), qi, q.map { $0._queued ?? false }) }
        return ([np.itemId], 0, nil)
    }
}
