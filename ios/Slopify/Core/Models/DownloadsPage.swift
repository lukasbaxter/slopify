import Foundation

/// `GET /api/downloads?scope=` (API.md §18.2). Album acquisition requests: what the drawer's
/// Downloads page lists (UI.md 5.9). Lenient decoding: unknown states and missing fields are kept
/// out of the way rather than failing the page.
struct DownloadsPage: Decodable, Equatable, Sendable {
    struct Search: Decodable, Equatable, Sendable {
        var at: Double?
        var results: Int?
        var outcome: String?
    }

    struct Item: Decodable, Equatable, Identifiable, Sendable {
        var id: Int
        var artist: String?
        var title: String
        var type: String?
        var year: String?
        var image: String?
        var state: String
        var total: Int
        var done: Int
        var requested: Double?
        var started: Double?
        var progressAt: Double?
        var finished: Double?
        var reason: String?
        var via: String?
        var detail: String?
        var libraryAlbumId: String?
        var note: String?
        var search: Search?

        enum Key: String, CodingKey {
            case id, artist, title, type, year, image, state, total, done, requested, started, progressAt, finished
            case reason, via, detail, libraryAlbumId, note, search
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: Key.self)
            id = try c.decode(Int.self, forKey: .id)
            artist = try? c.decodeIfPresent(String.self, forKey: .artist)
            title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
            type = try? c.decodeIfPresent(String.self, forKey: .type)
            // `year` is a string in the contract; accept a number too.
            if let s = try? c.decodeIfPresent(String.self, forKey: .year) { year = s }
            else if let n = try? c.decodeIfPresent(Int.self, forKey: .year) { year = String(n) } else { year = nil }
            image = try? c.decodeIfPresent(String.self, forKey: .image)
            state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? ""
            total = (try? c.decodeIfPresent(Int.self, forKey: .total)) ?? 0
            done = (try? c.decodeIfPresent(Int.self, forKey: .done)) ?? 0
            requested = try? c.decodeIfPresent(Double.self, forKey: .requested)
            started = try? c.decodeIfPresent(Double.self, forKey: .started)
            progressAt = try? c.decodeIfPresent(Double.self, forKey: .progressAt)
            finished = try? c.decodeIfPresent(Double.self, forKey: .finished)
            reason = try? c.decodeIfPresent(String.self, forKey: .reason)
            via = try? c.decodeIfPresent(String.self, forKey: .via)
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            libraryAlbumId = try? c.decodeIfPresent(String.self, forKey: .libraryAlbumId)
            note = try? c.decodeIfPresent(String.self, forKey: .note)
            search = try? c.decodeIfPresent(Search.self, forKey: .search)
        }

        init(id: Int, title: String, artist: String? = nil, type: String? = nil, year: String? = nil, state: String,
             total: Int = 0, done: Int = 0, requested: Double? = nil, started: Double? = nil, progressAt: Double? = nil,
             finished: Double? = nil, reason: String? = nil, via: String? = nil, detail: String? = nil,
             libraryAlbumId: String? = nil, note: String? = nil, search: Search? = nil, image: String? = nil) {
            self.id = id; self.title = title; self.artist = artist; self.type = type; self.year = year; self.state = state
            self.total = total; self.done = done; self.requested = requested; self.started = started
            self.progressAt = progressAt; self.finished = finished; self.reason = reason; self.via = via
            self.detail = detail; self.libraryAlbumId = libraryAlbumId; self.note = note; self.search = search
            self.image = image
        }
    }

    struct Watcher: Decodable, Equatable, Sendable {
        var lastCheck: Double?
        var next: Double?
        var checking: Bool?
        var perCheck: Int?
        var wanted: Int?
    }

    var items: [Item]
    var stuckAfterMs: Double?
    var watcher: Watcher?

    enum Key: String, CodingKey { case items, stuckAfterMs, watcher }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: Key.self)
        items = (try? c.decodeIfPresent([Item].self, forKey: .items)) ?? []
        stuckAfterMs = try? c.decodeIfPresent(Double.self, forKey: .stuckAfterMs)
        watcher = try? c.decodeIfPresent(Watcher.self, forKey: .watcher)
    }

    init(items: [Item], stuckAfterMs: Double? = nil, watcher: Watcher? = nil) {
        self.items = items; self.stuckAfterMs = stuckAfterMs; self.watcher = watcher
    }
}


/// `scope=` of `GET /api/downloads`: this account's requests, or everything Lidarr is moving.
enum DownloadScope: String, CaseIterable, Sendable { case mine, all }
