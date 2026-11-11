import Foundation

/// One queue row. `queued` = added with "Add to queue" (web `_queued`); `rec` = a smart
/// shuffle pick mixed in (web `_rec`), never part of the remembered original order.
struct QueueEntry: Codable, Hashable, Sendable {
    var track: Track
    var queued = false
    var rec = false
}

/// What happens when a song ends (`auto`) or next is pressed. Mirrors `advance` in
/// web/src/player/usePlayer.js.
enum Advance: Equatable, Sendable {
    case skip(Int)
    /// Repeat one: the same song from the top.
    case replay
    /// Repeat all at the end: the context from the top (fresh order when shuffled).
    case restart
    /// Played from an artist page: more of that artist.
    case moreOfArtist(String)
    /// Autoplay: similar songs appended. `orRestart`: start the context over if none.
    case autoplay(orRestart: Bool)
    /// Sleep timer "end of track": park paused at the start of `index`.
    case sleepStop(index: Int)
}

/// The local play queue: order, original (unshuffled) order, modes. Pure value type so the
/// rules are testable without audio. Every rule cites the web function it copies.
struct PlayQueue: Codable, Equatable, Sendable {
    var entries: [QueueEntry] = []
    /// The real order while shuffled (web `originalQueueRef`).
    var original: [QueueEntry] = []
    var index = 0
    var context: String?
    var shuffle: Player.Shuffle = .off
    var repeatMode: Player.Repeat = .off

    var current: QueueEntry? { entries.indices.contains(index) ? entries[index] : nil }
    var tracks: [Track] { entries.map(\.track) }
    var isEmpty: Bool { entries.isEmpty }

    /// web `playQueue`: shuffled keeps the chosen track first and scrambles the rest.
    mutating func start<G: RandomNumberGenerator>(_ list: [Track], at start: Int, context ctx: String?, using rng: inout G) {
        let rows = list.map { QueueEntry(track: $0) }
        let i = rows.indices.contains(start) ? start : 0
        context = ctx
        original = rows
        if shuffle != .off, rows.count > 1 {
            var rest = rows; let chosen = rest.remove(at: i)
            entries = [chosen] + rest.shuffled(using: &rng)
            index = 0
        } else {
            entries = rows
            index = rows.isEmpty ? 0 : i
        }
    }

    /// Take a queue as handed over (transfer, session adoption): no reshuffle.
    mutating func adopt(_ rows: [QueueEntry], index i: Int, original orig: [QueueEntry]? = nil, context ctx: String?) {
        entries = rows
        index = rows.isEmpty ? 0 : min(max(0, i), rows.count - 1)
        original = (orig?.isEmpty == false ? orig : nil) ?? rows
        context = ctx
    }

    /// web `addToQueue`: after the current song and anything already queued that way,
    /// ahead of the rest of the context. An empty queue just becomes the tracks.
    /// Returns true when the queue was empty (caller shows it paused).
    @discardableResult
    mutating func add(_ list: [Track]) -> Bool {
        guard !list.isEmpty else { return false }
        if entries.isEmpty {
            entries = list.map { QueueEntry(track: $0) }
            original = entries; index = 0
            return true
        }
        var at = index + 1
        while at < entries.count, entries[at].queued { at += 1 }
        let flagged = list.map { QueueEntry(track: $0, queued: true) }
        entries.insert(contentsOf: flagged, at: at)
        original += flagged
        return false
    }

    /// "Play next": straight after the current song, ahead of other queued songs.
    /// The web has no such action; marked queued like "Add to queue".
    @discardableResult
    mutating func insertNext(_ list: [Track]) -> Bool {
        guard !list.isEmpty else { return false }
        if entries.isEmpty { return add(list) }
        let flagged = list.map { QueueEntry(track: $0, queued: true) }
        entries.insert(contentsOf: flagged, at: min(index + 1, entries.count))
        original += flagged
        return false
    }

    /// web `removeFromQueue`: never the current one.
    @discardableResult
    mutating func remove(at pos: Int) -> Bool {
        guard entries.indices.contains(pos), pos != index else { return false }
        entries.remove(at: pos)
        if pos < index { index -= 1 }
        return true
    }

    /// web `moveInQueue`: only the upcoming part moves.
    @discardableResult
    mutating func move(from: Int, to: Int) -> Bool {
        guard from != to, from > index, to > index, from < entries.count, to < entries.count else { return false }
        let it = entries.remove(at: from)
        entries.insert(it, at: to)
        return true
    }

    /// web `clearQueued`: every queued song after the current one.
    mutating func clearQueued() {
        entries = entries.enumerated().filter { $0.offset <= index || !$0.element.queued }.map(\.element)
    }

    /// web `applyShuffleOrder`: re-order for a mode change, keeping the current song.
    mutating func setShuffle<G: RandomNumberGenerator>(_ mode: Player.Shuffle, using rng: inout G) {
        defer { shuffle = mode }
        let cur = current
        if mode != .off {
            if shuffle == .off { original = entries }
            if let cur, entries.count > 1 {
                let rest = entries.filter { $0.track.id != cur.track.id }
                entries = [cur] + rest.shuffled(using: &rng)
                index = 0
            }
        } else {
            let orig = original.isEmpty ? entries : original
            let pos = cur.map { c in max(0, orig.firstIndex { $0.track.id == c.track.id } ?? 0) } ?? index
            entries = orig
            index = entries.isEmpty ? 0 : min(pos, entries.count - 1)
        }
    }

    /// web `restart`: shuffled, a fresh order that does not open on the song that just played.
    mutating func restartOrder<G: RandomNumberGenerator>(using rng: inout G) {
        if shuffle != .off, entries.count > 1 {
            let last = current
            let base = (original.isEmpty ? entries : original).filter { !$0.queued }
            var order = base.shuffled(using: &rng)
            if order.count > 1, let last, order[0].track.id == last.track.id { order.append(order.removeFirst()) }
            entries = order
        }
        index = 0
    }

    /// web `smartNext` / early extension: songs not in the queue yet appended (the seed is
    /// dropped too, it is always in the queue). Shuffled only under smart shuffle.
    /// `fallbackAllowNonSeed`: smartNext takes repeats rather than nothing (manual skip).
    @discardableResult
    mutating func appendAutoplay<G: RandomNumberGenerator>(_ fresh: [Track], seedId: String?, fallbackAllowNonSeed: Bool = false, using rng: inout G) -> Int {
        let have = Set(entries.map(\.track.id))
        var pick = fresh.filter { !have.contains($0.id) && $0.id != seedId }
        if pick.isEmpty, fallbackAllowNonSeed { pick = fresh.filter { $0.id != seedId } }
        guard !pick.isEmpty else { return 0 }
        if shuffle == .smart { pick.shuffle(using: &rng) }
        entries += pick.map { QueueEntry(track: $0) }
        return pick.count
    }

    /// web `moreOfArtist`: appended to both the queue and the original order.
    mutating func appendMore(_ list: [Track]) -> Int {
        let have = Set(entries.map(\.track.id))
        let pick = list.filter { !have.contains($0.id) }
        let rows = pick.map { QueueEntry(track: $0) }
        entries += rows; original += rows
        return rows.count
    }

    /// web `blendSmart`: one pick after every third upcoming song.
    mutating func blendSmart(_ recs: [Track]) -> Int {
        let have = Set(entries.map(\.track.id))
        let picks = recs.filter { !have.contains($0.id) }
        guard !picks.isEmpty, entries.count - index >= 4 else { return 0 }
        var out = Array(entries[...index]); var r = 0
        for (k, e) in entries[(index + 1)...].enumerated() {
            out.append(e)
            if (k + 1) % 3 == 0, r < picks.count { out.append(QueueEntry(track: picks[r], rec: true)); r += 1 }
        }
        entries = out
        return r
    }

    /// How many smart picks to ask for (web `blendSmart`).
    var smartWant: Int { min(40, Int((Double(entries.count - index - 1) / 3).rounded(.up))) }

    /// web `advance`.
    func advance(auto: Bool, sleepEndOfTrack: Bool) -> Advance {
        let n = entries.count, i = index
        if auto, sleepEndOfTrack { return .sleepStop(index: i + 1 < n ? i + 1 : repeatMode == .all ? 0 : i) }
        if auto, repeatMode == .one { return .replay }
        if i + 1 < n { return .skip(i + 1) }
        if repeatMode == .all { return .restart }
        if repeatMode == .one { return .replay }
        if let ctx = context, ctx.hasPrefix("artist:") { return .moreOfArtist(String(ctx.dropFirst(7))) }
        return .autoplay(orRestart: context != nil)
    }

    /// web `previous`: restart past 3 s, else the song before (the first one restarts).
    func previous(position: Double) -> Advance {
        if position > 3 { return .replay }
        return index > 0 ? .skip(index - 1) : .replay
    }

    /// The song that plays after the current one ends on its own, if it is already known.
    var upcomingIndex: Int? {
        if repeatMode == .one { return entries.isEmpty ? nil : index }
        if index + 1 < entries.count { return index + 1 }
        return repeatMode == .all && shuffle == .off && !entries.isEmpty ? 0 : nil
    }

    var upcoming: QueueEntry? {
        if repeatMode == .one { return nil }
        if index + 1 < entries.count { return entries[index + 1] }
        // Repeat all reshuffles on restart (web `restart`), so only a plain order wraps early.
        return repeatMode == .all && shuffle == .off ? entries.first : nil
    }

    /// The early queue extension (web effect "queue's end, two songs early").
    func wantsEarlyExtension(remoteActive: Bool) -> Bool {
        guard !entries.isEmpty, entries.count - index <= 2, repeatMode == .off, !remoteActive else { return false }
        if let ctx = context, ctx.hasPrefix("artist:") { return false }
        return true
    }

    /// The transfer payload (API.md §20.6).
    func transfer(position: Double, playing: Bool, deviceId: String) -> Command.Transfer {
        Command.Transfer(trackIds: entries.map(\.track.id), queued: entries.map(\.queued), index: index,
                         position: position, playing: playing, ctx: context,
                         original: shuffle != .off && !original.isEmpty ? original.map(\.track.id) : nil,
                         deviceId: deviceId)
    }
}

extension Player.Repeat: Codable {}
extension Player.Shuffle: Codable {}

extension Array where Element == QueueEntry {
    /// web `markQueued`: carry handed-over flags onto fetched tracks (which may skip ids).
    static func marked(_ tracks: [Track], ids: [String], flags: [Bool]?) -> [QueueEntry] {
        guard let flags else { return tracks.map { QueueEntry(track: $0) } }
        var j = 0
        return tracks.map { t in
            while j < ids.count, ids[j] != t.id { j += 1 }
            let q = j < flags.count ? flags[j] : false
            j += 1
            return QueueEntry(track: t, queued: q)
        }
    }
}
