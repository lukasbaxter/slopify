import Foundation

/// Server → client frames (API.md §20.4). Parsed off the main actor.
enum SocketMessage: Equatable, Sendable {
    struct Sleep: Codable, Equatable, Sendable {
        var at: Double?
        var endOfTrack: Bool
    }
    struct HelloOk: Equatable, Sendable {
        var clientId: String?
        var userId: String?
        var offsets: [String: Double]
        var now: Double?
        var sleep: Sleep?
    }
    struct Roster: Equatable, Sendable {
        var players: [RosterPlayer]
        var lanDevices: [LanDevice]
        var activeClientId: String?
    }

    case helloOk(HelloOk)
    case pong(now: Double, t: Double)
    case roster(Roster)
    case queue(from: String, queue: [QueueItem]?)
    case session(nowPlaying: NowPlaying, queue: [QueueItem], at: Double)
    case command(Command, from: String)
    case like(itemId: String, liked: Bool)
    case prefs([String: JSONValue])
    case sleep(Sleep?)
    case offset(id: String, offset: Double?)
    case unknown(String)

    /// nil for a frame that is not a JSON object with a string `type`, or a known type with a
    /// broken payload (both are ignored).
    static func parse(_ data: Data) -> SocketMessage? {
        try? JSONDecoder().decode(Wire.self, from: data).message
    }
    static func parse(_ text: String) -> SocketMessage? { parse(Data(text.utf8)) }

    private struct Wire: Decodable {
        let message: SocketMessage

        private enum K: String, CodingKey {
            case type, clientId, userId, offsets, now, sleep, t, players, lanDevices, activeClientId
            case from, queue, nowPlaying, at, command, itemId, liked, prefs, id, offset
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            let type = try c.decode(String.self, forKey: .type)
            switch type {
            case "hello-ok":
                let offsets = (try? c.decodeIfPresent([String: Double?].self, forKey: .offsets)) ?? nil
                message = .helloOk(HelloOk(
                    clientId: try c.decodeIfPresent(String.self, forKey: .clientId),
                    userId: try c.decodeIfPresent(String.self, forKey: .userId),
                    offsets: (offsets ?? [:]).compactMapValues { $0 },
                    now: try c.decodeIfPresent(Double.self, forKey: .now),
                    sleep: try c.decodeIfPresent(Sleep.self, forKey: .sleep)))
            case "pong":
                message = .pong(now: try c.decode(Double.self, forKey: .now), t: try c.decode(Double.self, forKey: .t))
            case "roster":
                // One odd entry must not hide the whole roster.
                let players = try c.decodeIfPresent(Lossy<RosterPlayer>.self, forKey: .players)?.items ?? []
                let lan = try c.decodeIfPresent(Lossy<LanDevice>.self, forKey: .lanDevices)?.items ?? []
                message = .roster(Roster(players: players, lanDevices: lan,
                                         activeClientId: try c.decodeIfPresent(String.self, forKey: .activeClientId)))
            case "queue":
                message = .queue(from: try c.decode(String.self, forKey: .from),
                                 queue: try c.decodeIfPresent([QueueItem].self, forKey: .queue))
            case "session":
                message = .session(nowPlaying: try c.decode(NowPlaying.self, forKey: .nowPlaying),
                                   queue: try c.decodeIfPresent([QueueItem].self, forKey: .queue) ?? [],
                                   at: try c.decodeIfPresent(Double.self, forKey: .at) ?? 0)
            case "command":
                message = .command(try c.decode(Command.self, forKey: .command),
                                   from: try c.decodeIfPresent(String.self, forKey: .from) ?? "")
            case "like":
                message = .like(itemId: try c.decode(String.self, forKey: .itemId), liked: try c.decode(Bool.self, forKey: .liked))
            case "prefs":
                message = .prefs(try c.decodeIfPresent([String: JSONValue].self, forKey: .prefs) ?? [:])
            case "sleep":
                message = .sleep(try c.decodeIfPresent(Sleep.self, forKey: .sleep))
            case "offset":
                message = .offset(id: try c.decode(String.self, forKey: .id), offset: try c.decodeIfPresent(Double.self, forKey: .offset))
            default:
                message = .unknown(type)
            }
        }
    }
}

/// Decodes an array, skipping elements that fail.
private struct Lossy<T: Decodable>: Decodable {
    var items: [T] = []
    private struct Skip: Decodable {}
    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        while !c.isAtEnd {
            if let v = try? c.decode(T.self) { items.append(v) } else { _ = try? c.decode(Skip.self) }
        }
    }
}

/// Client → server frames (API.md §20.3).
enum SocketOutgoing: Sendable {
    struct Hello: Equatable, Sendable {
        var token: String
        var clientId: String
        var instance: String
        var name: String
        var kind: String
        var form: String
        var canPlay: Bool
    }
    enum Sleep: Equatable, Sendable { case minutes(Int), endOfTrack, off, done }

    case hello(Hello)
    case ping(t: Double)
    case nowPlaying(NowPlaying?)
    case queue([QueueItem])
    case claim(reassertAgo: Double?)
    case command(Command, to: String)
    case prefs([String: JSONValue])
    case sleep(Sleep)
    case offset(id: String, offset: Double?)

    func data() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = .withoutEscapingSlashes
        return try e.encode(Frame(self))
    }

    func text() -> String? { (try? data()).flatMap { String(data: $0, encoding: .utf8) } }

    private struct Frame: Encodable {
        let m: SocketOutgoing
        init(_ m: SocketOutgoing) { self.m = m }

        private enum K: String, CodingKey {
            case type, token, clientId, instance, name, kind, form, canPlay, t, nowPlaying, queue
            case reassert, ago, to, command, prefs, minutes, endOfTrack, off, done, id, offset
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: K.self)
            switch m {
            case let .hello(h):
                try c.encode("hello", forKey: .type)
                try c.encode(h.token, forKey: .token); try c.encode(h.clientId, forKey: .clientId)
                try c.encode(h.instance, forKey: .instance); try c.encode(h.name, forKey: .name)
                try c.encode(h.kind, forKey: .kind); try c.encode(h.form, forKey: .form); try c.encode(h.canPlay, forKey: .canPlay)
            case let .ping(t):
                try c.encode("ping", forKey: .type); try c.encode(t, forKey: .t)
            case let .nowPlaying(np):
                // null is meaningful: it releases the session.
                try c.encode("nowplaying", forKey: .type); try c.encode(np, forKey: .nowPlaying)
            case let .queue(q):
                try c.encode("queue", forKey: .type); try c.encode(q, forKey: .queue)
            case let .claim(ago):
                try c.encode("claim", forKey: .type)
                if let ago { try c.encode(true, forKey: .reassert); try c.encode(ago.rounded(), forKey: .ago) }
            case let .command(cmd, to):
                try c.encode("command", forKey: .type); try c.encode(to, forKey: .to); try c.encode(cmd, forKey: .command)
            case let .prefs(p):
                try c.encode("prefs", forKey: .type); try c.encode(p, forKey: .prefs)
            case let .sleep(s):
                try c.encode("sleep", forKey: .type)
                switch s {
                case let .minutes(m): try c.encode(min(max(m, 1), 1440), forKey: .minutes)
                case .endOfTrack: try c.encode(true, forKey: .endOfTrack)
                case .off: try c.encode(true, forKey: .off)
                case .done: try c.encode(true, forKey: .off); try c.encode(true, forKey: .done)
                }
            case let .offset(id, offset):
                try c.encode("offset", forKey: .type); try c.encode(id, forKey: .id); try c.encode(offset, forKey: .offset)
            }
        }
    }
}
