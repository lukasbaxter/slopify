import Foundation

// Socket shapes (API.md §20.5). Positions in SECONDS here. PascalCase where the server uses it.

struct NameId: Codable, Hashable, Sendable {
    var Id: String?
    var Name: String
}

struct OutputDevice: Codable, Hashable, Sendable {
    var id: String
    var kind: String
    var name: String
    var members: [String]?
    static func local(_ name: String) -> OutputDevice { OutputDevice(id: "local", kind: "local", name: name) }
}

struct NowPlaying: Codable, Hashable, Sendable {
    var itemId: String
    var title: String
    var artist: String
    var album: String?
    var artUrl: String?
    var albumId: String?
    var artistId: String?
    var artists: [NameId]?
    var liked: Bool?
    var device: OutputDevice?
    var queueIndex: Int?
    var playing: Bool
    var held: Bool?
    var position: Double
    var duration: Double?
    var volume: Double?
    var `repeat`: String?
    var shuffle: String?
    var at: Double?
    /// Added by the server on relay. Use this for clock math.
    var serverAt: Double?
}

struct QueueItem: Codable, Hashable, Sendable {
    struct Favorite: Codable, Hashable, Sendable { var IsFavorite: Bool? }
    var Id: String
    var Name: String?
    var Artists: [String]?
    var AlbumArtist: String?
    var Album: String?
    var AlbumId: String?
    var RunTimeTicks: Int64?
    var ArtistItems: [NameId]?
    var AlbumArtists: [NameId]?
    var UserData: Favorite?
    var _queued: Bool?
    var _gain: Gain?

    init(_ t: Track, queued: Bool = false, liked: Bool = false) {
        Id = t.id; Name = t.title; Artists = t.artists; AlbumArtist = t.albumArtist; Album = t.album
        AlbumId = t.albumId; RunTimeTicks = Int64(t.durationMs) * 10_000
        ArtistItems = t.artistCredits.map { NameId(Id: $0.id, Name: $0.name) }
        AlbumArtists = [NameId(Id: t.artistIds.first, Name: t.albumArtist)]
        UserData = Favorite(IsFavorite: liked); _queued = queued; _gain = t.gain
    }
}

struct RosterPlayer: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var kind: String?
    var form: String?
    var canPlay: Bool?
    var nowPlaying: NowPlaying?
    var sameNetwork: Bool?
    var isServer: Bool { id.hasPrefix("server:") }
}

struct LanDevice: Codable, Hashable, Identifiable, Sendable {
    struct State: Codable, Hashable, Sendable {
        var volume: Double?
        var muted: Bool?
        var playing: Bool?
        var title: String?
        var input: String?
    }
    var id: String
    var kind: String
    var name: String
    var model: String?
    var group: [String]?
    var state: State?
    var viaClient: String?
}

/// Client-to-client command (API.md §20.5). Encoded flat: { action, ...fields }.
enum Command: Hashable, Sendable {
    case play(trackIds: [String], index: Int, ctx: String?, startAt: Double?)
    case transfer(Transfer)
    case enqueue(trackIds: [String])
    case queueRemove(index: Int)
    case queueMove(from: Int, to: Int)
    case queueClear
    case skipTo(index: Int)
    case toggle
    case setPlaying(Bool)
    case seek(pos: Double)
    case setVolume(level: Double)
    case volumeStep(Int)
    case next, previous
    case setRepeat(String)
    case setShuffle(String)
    case patchLiked(itemId: String, liked: Bool)
    case yield
    case unknown(String)

    struct Transfer: Codable, Hashable, Sendable {
        var trackIds: [String]
        var queued: [Bool]?
        var index: Int
        var position: Double
        var playing: Bool
        var ctx: String?
        var original: [String]?
        var deviceId: String
    }
}

extension Command: Codable {
    private enum K: String, CodingKey { case action, trackIds, index, ctx, startAt, from, to, playing, pos, level, step, mode, itemId, liked }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let a = try c.decode(String.self, forKey: .action)
        switch a {
        case "play": self = .play(trackIds: try c.decode([String].self, forKey: .trackIds), index: try c.decodeIfPresent(Int.self, forKey: .index) ?? 0,
                                  ctx: try c.decodeIfPresent(String.self, forKey: .ctx), startAt: try c.decodeIfPresent(Double.self, forKey: .startAt))
        case "transfer": self = .transfer(try Transfer(from: decoder))
        case "enqueue": self = .enqueue(trackIds: try c.decode([String].self, forKey: .trackIds))
        case "queueRemove": self = .queueRemove(index: try c.decode(Int.self, forKey: .index))
        case "queueMove": self = .queueMove(from: try c.decode(Int.self, forKey: .from), to: try c.decode(Int.self, forKey: .to))
        case "queueClear": self = .queueClear
        case "skipTo": self = .skipTo(index: try c.decode(Int.self, forKey: .index))
        case "toggle": self = .toggle
        case "setPlaying": self = .setPlaying(try c.decode(Bool.self, forKey: .playing))
        case "seek": self = .seek(pos: try c.decode(Double.self, forKey: .pos))
        case "setVolume": self = .setVolume(level: try c.decode(Double.self, forKey: .level))
        case "volumeStep": self = .volumeStep(try c.decode(Int.self, forKey: .step))
        case "next": self = .next
        case "previous": self = .previous
        case "setRepeat": self = .setRepeat(try c.decode(String.self, forKey: .mode))
        case "setShuffle": self = .setShuffle(try c.decode(String.self, forKey: .mode))
        case "patchLiked": self = .patchLiked(itemId: try c.decode(String.self, forKey: .itemId), liked: try c.decode(Bool.self, forKey: .liked))
        case "yield": self = .yield
        default: self = .unknown(a)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .play(ids, i, ctx, s):
            try c.encode("play", forKey: .action); try c.encode(ids, forKey: .trackIds); try c.encode(i, forKey: .index)
            try c.encodeIfPresent(ctx, forKey: .ctx); try c.encodeIfPresent(s, forKey: .startAt)
        case let .transfer(t): try t.encode(to: encoder); try c.encode("transfer", forKey: .action)
        case let .enqueue(ids): try c.encode("enqueue", forKey: .action); try c.encode(ids, forKey: .trackIds)
        case let .queueRemove(i): try c.encode("queueRemove", forKey: .action); try c.encode(i, forKey: .index)
        case let .queueMove(f, t): try c.encode("queueMove", forKey: .action); try c.encode(f, forKey: .from); try c.encode(t, forKey: .to)
        case .queueClear: try c.encode("queueClear", forKey: .action)
        case let .skipTo(i): try c.encode("skipTo", forKey: .action); try c.encode(i, forKey: .index)
        case .toggle: try c.encode("toggle", forKey: .action)
        case let .setPlaying(p): try c.encode("setPlaying", forKey: .action); try c.encode(p, forKey: .playing)
        case let .seek(p): try c.encode("seek", forKey: .action); try c.encode(p, forKey: .pos)
        case let .setVolume(l): try c.encode("setVolume", forKey: .action); try c.encode(l, forKey: .level)
        case let .volumeStep(s): try c.encode("volumeStep", forKey: .action); try c.encode(s, forKey: .step)
        case .next: try c.encode("next", forKey: .action)
        case .previous: try c.encode("previous", forKey: .action)
        case let .setRepeat(m): try c.encode("setRepeat", forKey: .action); try c.encode(m, forKey: .mode)
        case let .setShuffle(m): try c.encode("setShuffle", forKey: .action); try c.encode(m, forKey: .mode)
        case let .patchLiked(id, l): try c.encode("patchLiked", forKey: .action); try c.encode(id, forKey: .itemId); try c.encode(l, forKey: .liked)
        case .yield: try c.encode("yield", forKey: .action)
        case let .unknown(a): try c.encode(a, forKey: .action)
        }
    }
}
