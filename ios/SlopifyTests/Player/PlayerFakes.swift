import Foundation
@testable import Slopify

func makeTrack(_ id: String, album: String = "al1", artistId: String = "ar1", ms: Int = 200_000, gain: Gain? = nil) -> Track {
    Track(id: id, title: "T\(id)", artist: "Artist", artists: ["Artist"], artistIds: [artistId], albumId: album, album: "Album",
          albumArtist: "Artist", trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: ms, codec: nil, bitrate: nil,
          cover: nil, format: nil, gain: gain, addedAt: nil, plays: nil)
}

func tracks(_ ids: String...) -> [Track] { ids.map { makeTrack($0) } }

@MainActor
final class FakeEngine: AudioEngine {
    weak var events: AudioEngineEvents?
    var currentId: String?
    var currentTime: Double = 0
    var playing = false
    var volume: Float = 1
    var loads: [(AudioItem, Double, Bool)] = []
    var next: (AudioItem?, AudioTransition)?
    var unloads = 0
    var seeks: [Double] = []

    func load(_ item: AudioItem, at seconds: Double, play: Bool) {
        loads.append((item, seconds, play)); currentId = item.id; currentTime = seconds; playing = play
    }
    func setNext(_ item: AudioItem?, transition: AudioTransition) { next = (item, transition) }
    func play() { playing = true }
    func pause() { playing = false }
    func seek(to seconds: Double) { seeks.append(seconds); currentTime = seconds }
    func setVolume(_ v: Float) { volume = v }
    func unload() { unloads += 1; currentId = nil; playing = false }
}

@MainActor
final class FakeLink: PlayerSessionLink {
    var connection: SessionClient.Connection = .connected
    var clientId = "me"
    var players: [RosterPlayer] = []
    var activeClientId: String?
    var queues: [String: [QueueItem]] = [:]
    var lastSession: (nowPlaying: NowPlaying, queue: [QueueItem], at: Double)?
    var sleep: (at: Double?, endOfTrack: Bool)?
    var onCommand: ((Command, String) -> Void)?
    var claims = 0
    var reports: [NowPlaying?] = []
    var published: [[QueueItem]] = []
    var sent: [(Command, String)] = []
    var sleepDones = 0

    func claim() { claims += 1 }
    func report(_ np: NowPlaying?) { reports.append(np) }
    func publishQueue(_ queue: [QueueItem]) { published.append(queue) }
    func send(_ command: Command, to clientId: String) { sent.append((command, clientId)) }
    func sleepDone() { sleepDones += 1 }
    func playhead(_ np: NowPlaying) -> Double { np.position }
}

@MainActor
final class FakeBackend: PlayerBackend {
    var token: String? = "tok"
    var library: [String: Track] = [:]
    var mixes: [String: [Track]] = [:]
    var mixCalls: [(String, Int?, String?)] = []
    var warms: [[String]] = []
    var plays: [String] = []

    func tracks(ids: [String]) async throws -> [Track] { ids.compactMap { library[$0] } }
    func mix(_ id: String, limit: Int?, mode: String?) async throws -> Mix {
        mixCalls.append((id, limit, mode))
        return Mix(items: mixes[id] ?? [], from: nil, day: nil)
    }
    func artist(_ id: String) async throws -> ArtistDetail { throw APIError.http(404, "no") }
    func warm(ids: [String], profile: String, norm: String?) async throws { warms.append(ids) }
    func postPlay(trackId: String, at: Double?, client: String) async throws { plays.append(trackId) }
    func hlsURL(trackId: String, max: String, norm: String?) -> URL {
        URL(string: "http://srv/api/stream/\(trackId)/hls/master.m3u8?max=\(max)\(norm.map { "&norm=\($0)" } ?? "")")!
    }
    func imageURL(id: String, size: Int, banner: Bool, bust: String?) -> URL { URL(string: "http://srv/api/image/\(id)?size=\(size)")! }
    func imageData(id: String, size: Int) async -> Data? { nil }
    var prewarms: [URL] = []
    func prewarm(master: URL) async { prewarms.append(master) }
}

@MainActor
func makePlayer(prefs: [String: JSONValue] = [:]) -> (Player, FakeEngine, FakeLink, FakeBackend) {
    let p = Player(), e = FakeEngine(), l = FakeLink(), b = FakeBackend()
    p.rng = SplitMix64(seed: 42)
    p.isTablet = false
    Player.headStartMs = 0
    p.configure(backend: b, link: l, prefs: { prefs }, engine: e, audioSession: nil, lockScreen: nil, store: nil)
    return (p, e, l, b)
}

func np(_ id: String, index: Int? = nil, playing: Bool = true, position: Double = 10) -> NowPlaying {
    NowPlaying(itemId: id, title: "T\(id)", artist: "Artist", album: "Album", artUrl: nil, albumId: "al1", artistId: "ar1",
               artists: [NameId(Id: "ar1", Name: "Artist")], liked: false, device: OutputDevice.local("This Computer"),
               queueIndex: index, playing: playing, held: false, position: position, duration: 200, volume: 70,
               repeat: "all", shuffle: "off", at: 0, serverAt: nil)
}
