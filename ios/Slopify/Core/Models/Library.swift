import Foundation

// REST shapes (docs/API.md §5). Durations in ms, timestamps epoch ms.

struct Format: Codable, Hashable, Sendable {
    var codec: String?
    var lossless: Bool?
    var bitrate: Double?
    var sampleRate: Double?
    var bitDepth: Double?
}

struct Gain: Codable, Hashable, Sendable {
    var track: Double?
    var album: Double?
}

struct Track: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var title: String
    var artist: String
    var artists: [String]
    var artistIds: [String]
    var albumId: String
    var album: String
    var albumArtist: String
    var trackNo: Int?
    var discNo: Int?
    var year: Int?
    var genres: [String]?
    var durationMs: Int
    var codec: String?
    var bitrate: Double?
    var cover: String?
    var format: Format?
    var gain: Gain?
    var addedAt: Double?
    /// Only on /api/home topTracks.
    var plays: Int?

    var duration: TimeInterval { Double(durationMs) / 1000 }
    /// (artist name, artist id) pairs; ids may be shorter than names on odd data.
    var artistCredits: [(name: String, id: String?)] {
        artists.enumerated().map { ($0.element, $0.offset < artistIds.count ? artistIds[$0.offset] : nil) }
    }
}

struct Album: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var artist: String
    var artistId: String?
    var year: Int?
    var trackCount: Int?
    var durationMs: Int?
    var cover: String?
    var addedAt: Double?
    var likedAt: Double?
}

struct AlbumDetail: Codable, Hashable, Sendable {
    var album: Album
    var tracks: [Track]
    init(from decoder: Decoder) throws {
        album = try Album(from: decoder)
        tracks = try decoder.container(keyedBy: K.self).decode([Track].self, forKey: .tracks)
    }
    func encode(to encoder: Encoder) throws {
        try album.encode(to: encoder)
        var c = encoder.container(keyedBy: K.self); try c.encode(tracks, forKey: .tracks)
    }
    private enum K: String, CodingKey { case tracks }
}

struct Artist: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var trackCount: Int?
    var albumCount: Int?
    var image: String?
    var banner: String?
    var followedAt: Double?
}

struct ArtistDetail: Codable, Hashable, Sendable {
    var artist: Artist
    var followed: Bool
    var albums: [Album]
    var appearsOn: [Album]
    var tracks: [Track]
    init(from decoder: Decoder) throws {
        artist = try Artist(from: decoder)
        let c = try decoder.container(keyedBy: K.self)
        followed = try c.decodeIfPresent(Bool.self, forKey: .followed) ?? false
        albums = try c.decodeIfPresent([Album].self, forKey: .albums) ?? []
        appearsOn = try c.decodeIfPresent([Album].self, forKey: .appearsOn) ?? []
        tracks = try c.decodeIfPresent([Track].self, forKey: .tracks) ?? []
    }
    func encode(to encoder: Encoder) throws {
        try artist.encode(to: encoder)
        var c = encoder.container(keyedBy: K.self)
        try c.encode(followed, forKey: .followed); try c.encode(albums, forKey: .albums)
        try c.encode(appearsOn, forKey: .appearsOn); try c.encode(tracks, forKey: .tracks)
    }
    private enum K: String, CodingKey { case followed, albums, appearsOn, tracks }
}

struct Playlist: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var userId: String?
    var created: Double?
    var updated: Double?
    var trackCount: Int?
    var cover: String?
    var aiPrompt: String?
}

struct PlaylistDetail: Codable, Hashable, Sendable {
    var playlist: Playlist
    var tracks: [Track]
    init(from decoder: Decoder) throws {
        playlist = try Playlist(from: decoder)
        tracks = try decoder.container(keyedBy: K.self).decodeIfPresent([Track].self, forKey: .tracks) ?? []
    }
    func encode(to encoder: Encoder) throws {
        try playlist.encode(to: encoder)
        var c = encoder.container(keyedBy: K.self); try c.encode(tracks, forKey: .tracks)
    }
    private enum K: String, CodingKey { case tracks }
}

struct Page<T: Codable & Sendable>: Codable, Sendable {
    var items: [T]
    var total: Int?
    var offset: Int?
    var limit: Int?
}

struct Items<T: Codable & Sendable>: Codable, Sendable { var items: [T] }

struct LibraryInfo: Codable, Sendable {
    var version: String
    var tracks: Int?
    var albums: Int?
    var artists: Int?
}

struct HomeData: Codable, Sendable {
    var recentAlbums: [Album]
    var topTracks: [Track]
    var newestAlbums: [Album]
}

struct BrowseTile: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var name: String
    var count: Int?
    var coverId: String?
    var cover: String?
    var covers: [String]?
    var kind: String?
}

struct SearchResults: Codable, Sendable {
    var tracks: [Track]
    var albums: [Album]
    var artists: [Artist]
}

struct ItemLookup: Codable, Sendable {
    enum Kind: String, Codable, Sendable { case album, artist, track }
    var kind: Kind
    var item: JSONValue
}

struct GenreDetail: Codable, Sendable {
    struct TopArtist: Codable, Hashable, Sendable { var id: String; var name: String; var plays: Int?; var albums: Int? }
    var name: String
    var trackCount: Int?
    var albumCount: Int?
    var topArtists: [TopArtist]
    var albums: [Album]
    var recent: [Album]
}

/// Upstream (Lidarr) release; snake_case fields as the server sends them.
struct Release: Codable, Hashable, Sendable {
    var album_id: String?
    var title: String
    var artist: String?
    var rtype: String?
    var year: String?
    var date: String?
    var image: String?
    var total_tracks: Int?
    var inLibrary: String?
    var localName: String?
    var artistId: String?
    /// Only on /api/radar.
    var artistName: String?
    var requestStatus: String?
}

extension Release {
    private enum K: String, CodingKey {
        case album_id, title, artist, rtype, year, date, image, total_tracks, inLibrary, localName, artistId, artistName, requestStatus
    }

    /// `year` is a string in the contract (lidarr.ts), but a radar list the server kept from an
    /// older build can carry a number: take either.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        album_id = try c.decodeIfPresent(String.self, forKey: .album_id)
        title = try c.decode(String.self, forKey: .title)
        artist = try c.decodeIfPresent(String.self, forKey: .artist)
        rtype = try c.decodeIfPresent(String.self, forKey: .rtype)
        if let y = try? c.decodeIfPresent(String.self, forKey: .year) { year = y }
        else if let n = try? c.decodeIfPresent(Int.self, forKey: .year) { year = String(n) }
        else { year = nil }
        date = try c.decodeIfPresent(String.self, forKey: .date)
        image = try c.decodeIfPresent(String.self, forKey: .image)
        total_tracks = try c.decodeIfPresent(Int.self, forKey: .total_tracks)
        inLibrary = try c.decodeIfPresent(String.self, forKey: .inLibrary)
        localName = try c.decodeIfPresent(String.self, forKey: .localName)
        artistId = try c.decodeIfPresent(String.self, forKey: .artistId)
        artistName = try c.decodeIfPresent(String.self, forKey: .artistName)
        requestStatus = try c.decodeIfPresent(String.self, forKey: .requestStatus)
    }
}

extension Release: Identifiable {
    /// Two artists can share a release (splits, features): the key needs both ids.
    var id: String { "\(album_id ?? title):\(artistId ?? "")" }
}

struct Discography: Codable, Sendable {
    struct Head: Codable, Sendable { var name: String; var image: String? }
    var artist: Head?
    var releases: [Release]
}

struct EverywhereResults: Codable, Sendable {
    struct ArtistHit: Codable, Hashable, Sendable { var name: String; var id: String? }
    var albums: [Release]
    var artists: [ArtistHit]
}

struct Lyrics: Codable, Sendable {
    struct Line: Codable, Hashable, Sendable { var start: Int?; var text: String }
    var kind: String // synced | plain | instrumental
    var source: String?
    var lines: [Line]
}

struct LyricJob: Codable, Hashable, Sendable {
    var trackId: String
    var title: String?
    var state: String
    var step: String?
    var ahead: Int?
    var result: String?
    var requested: Double?
    var finished: Double?
    /// Only on POST /sync: a job for this song was already queued or running.
    var already: Bool?
}

struct LyricJobs: Codable, Sendable { var jobs: [LyricJob] }

struct FolderCover: Codable, Sendable { var ok: Bool?; var cover: String? }

struct LibraryLayout: Codable, Sendable {
    struct Folder: Codable, Hashable, Identifiable, Sendable { var id: String; var name: String; var cover: String?; var items: [String] }
    var order: [String]
    var folders: [Folder]
}

struct HistoryPage: Codable, Sendable {
    struct Entry: Codable, Hashable, Sendable { var at: Double; var client: String?; var track: Track }
    var items: [Entry]
}

struct TopSongYears: Codable, Sendable {
    struct Year: Codable, Hashable, Sendable { var year: Int; var songs: Int; var plays: Int; var top: Track? }
    var years: [Year]
}

struct Mix: Codable, Sendable {
    var items: [Track]
    var from: String?
    var day: String?
}

struct LikesMap: Codable, Sendable {
    var at: [String: Double]
    var items: [Track]?
}

struct LikeResult: Codable, Sendable { var ok: Bool; var at: Double?; var album: Bool?; var artist: Bool? }
struct OK: Codable, Sendable { var ok: Bool? }
struct Created: Codable, Sendable { var id: String; var name: String }
