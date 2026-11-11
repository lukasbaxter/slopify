import Foundation

/// `GET /api/history?range=&tzo=` (API.md §15.2, server social.ts). Lenient: every field optional,
/// numbers accepted as ints or doubles, so an older server never breaks the page.
struct HistoryStats: Decodable, Equatable, Sendable {
    struct Numbers: Decodable, Equatable, Sendable {
        var streams: Int?
        var minutes: Int?
        var daysStreamed: Int?
        var uniqueTracks: Int?
        var uniqueArtists: Int?
        var uniqueAlbums: Int?

        init(streams: Int? = nil, minutes: Int? = nil, daysStreamed: Int? = nil, uniqueTracks: Int? = nil, uniqueArtists: Int? = nil, uniqueAlbums: Int? = nil) {
            self.streams = streams; self.minutes = minutes; self.daysStreamed = daysStreamed
            self.uniqueTracks = uniqueTracks; self.uniqueArtists = uniqueArtists; self.uniqueAlbums = uniqueAlbums
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: Key.self)
            streams = c.int(.streams); minutes = c.int(.minutes); daysStreamed = c.int(.daysStreamed)
            uniqueTracks = c.int(.uniqueTracks); uniqueArtists = c.int(.uniqueArtists); uniqueAlbums = c.int(.uniqueAlbums)
        }
        enum Key: String, CodingKey { case streams, minutes, daysStreamed, uniqueTracks, uniqueArtists, uniqueAlbums }
    }

    struct TopTrack: Decodable, Equatable, Sendable {
        var id: String?
        var name: String
        var artist: String?
        var artistId: String?
        var albumId: String?
        var count: Int
        var seconds: Double
    }
    struct TopArtist: Decodable, Equatable, Sendable {
        var artistId: String?
        var name: String
        var count: Int
        var seconds: Double
    }
    struct TopAlbum: Decodable, Equatable, Sendable {
        var albumId: String?
        var name: String
        var artist: String?
        var count: Int
        var seconds: Double
    }
    struct Genre: Decodable, Equatable, Sendable { var id: String; var name: String }
    struct Day: Decodable, Equatable, Sendable { var day: String; var count: Int; var minutes: Int }

    var connected: Bool
    var total: Int
    var spotify: Int
    var numbers: Numbers
    var prev: Numbers?
    var topTracks: [TopTrack]
    var topArtists: [TopArtist]
    var topAlbums: [TopAlbum]
    var topGenres: [Genre]
    var perDay: [Day]
    var byHour: [Double]
    var byHourSeconds: [Double]?

    enum Key: String, CodingKey {
        case connected, total, sources, prev, topTracks, topArtists, topAlbums, topGenres, perDay, byHour, byHourSeconds
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: Key.self)
        connected = (try? c.decodeIfPresent(Bool.self, forKey: .connected)) ?? false
        total = c.int(.total) ?? 0
        let sources = (try? c.decodeIfPresent([String: Double].self, forKey: .sources))
        spotify = Int(sources?["spotify"] ?? 0)
        numbers = try Numbers(from: d)
        prev = try? c.decodeIfPresent(Numbers.self, forKey: .prev)
        topTracks = Self.lossy(c, .topTracks)
        topArtists = Self.lossy(c, .topArtists)
        topAlbums = Self.lossy(c, .topAlbums)
        topGenres = Self.lossy(c, .topGenres)
        perDay = Self.lossy(c, .perDay)
        byHour = (try? c.decodeIfPresent([Double].self, forKey: .byHour)) ?? Array(repeating: 0, count: 24)
        byHourSeconds = (try? c.decodeIfPresent([Double].self, forKey: .byHourSeconds))
    }

    private static func lossy<T: Decodable>(_ c: KeyedDecodingContainer<Key>, _ k: Key) -> [T] {
        (try? c.decodeIfPresent([T].self, forKey: k)) ?? []
    }

    /// For previews and tests.
    init(connected: Bool, total: Int = 0, spotify: Int = 0, numbers: Numbers = .init(), prev: Numbers? = nil,
         topTracks: [TopTrack] = [], topArtists: [TopArtist] = [], topAlbums: [TopAlbum] = [], topGenres: [Genre] = [],
         perDay: [Day] = [], byHour: [Double] = Array(repeating: 0, count: 24), byHourSeconds: [Double]? = nil) {
        self.connected = connected; self.total = total; self.spotify = spotify; self.numbers = numbers; self.prev = prev
        self.topTracks = topTracks; self.topArtists = topArtists; self.topAlbums = topAlbums; self.topGenres = topGenres
        self.perDay = perDay; self.byHour = byHour; self.byHourSeconds = byHourSeconds
    }
}

private extension KeyedDecodingContainer {
    /// An int that may arrive as a double.
    func int(_ k: Key) -> Int? {
        if let i = try? decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: k), d.isFinite { return Int(d.rounded()) }
        return nil
    }
}
