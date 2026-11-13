import Foundation

/// "PLAYING FROM <KIND>" / "<name>" (usePlayingFrom, Player.jsx:23-59). Always two lines.
struct NowPlayingFrom: Equatable, Sendable {
    var kind: String
    var name: String

    static var fallback: NowPlayingFrom { NowPlayingFrom(kind: L("PLAYING FROM"), name: L("Your Library")) }

    /// What a context id names without a lookup; nil when it needs one.
    static func immediate(_ ctx: String?) -> NowPlayingFrom? {
        guard let ctx, !ctx.isEmpty else { return .fallback }
        if ctx == "liked" || ctx == "__liked__" { return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("Liked Songs")) }
        if ctx == "radar" { return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("Release Radar")) }
        // The web's genre tiles are `browse:<id>`; the native player names genres `genre:<name>`.
        if ctx.hasPrefix("genre:") {
            let name = String(ctx.dropFirst(6))
            return NowPlayingFrom(kind: L("PLAYING FROM GENRE"), name: name.isEmpty ? L("Genre") : name)
        }
        if ctx.hasPrefix("browse:") { return NowPlayingFrom(kind: L("PLAYING FROM GENRE"), name: L("Genre")) }
        return nil
    }

    /// The id to look up for a library context (`ctxItemId`).
    static func itemId(_ ctx: String) -> String {
        if ctx.hasPrefix("artist:") { return String(ctx.dropFirst(7)) }
        if ctx.hasPrefix("mix:") { return String(ctx.dropFirst(4)) }
        if ctx.hasPrefix("radio:") { return String(ctx.dropFirst(6)) }
        return ctx
    }

    /// Resolve with the server (`/api/items/:id`, `/api/playlists/:id`).
    @MainActor
    static func resolve(_ ctx: String?, api: APIClient) async -> NowPlayingFrom {
        if let p = immediate(ctx) { return p }
        guard let ctx else { return .fallback }
        let id = itemId(ctx)
        if ctx.hasPrefix("mix:") {
            // TODO(lead): the Home top-artists list (first 16) to number "Daily Mix {n}" like the web.
            if let it = try? await api.lookup(id), let n = it.item["name"]?.string {
                return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("{name} Mix", ["name": n]))
            }
            return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("Daily Mix"))
        }
        if ctx.hasPrefix("radio:") {
            // Go to radio's playlist: "<seed> Radio" (Player.jsx).
            let n: String?
            if id.hasPrefix("pl_") { n = (try? await api.playlist(id))?.playlist.name }
            else if let it = try? await api.lookup(id) { n = it.item["name"]?.string ?? it.item["title"]?.string } else { n = nil }
            guard let n, !n.isEmpty else { return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("Playlist")) }
            return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: L("{name} Radio", ["name": n]))
        }
        if id.hasPrefix("pl_") {
            if let p = try? await api.playlist(id) { return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: p.playlist.name) }
            return .fallback
        }
        guard let it = try? await api.lookup(id) else { return .fallback }
        let name = it.item["name"]?.string ?? it.item["title"]?.string ?? ""
        guard !name.isEmpty else { return .fallback }
        switch it.kind {
        case .artist: return NowPlayingFrom(kind: L("PLAYING FROM ARTIST"), name: name)
        case .album: return NowPlayingFrom(kind: L("PLAYING FROM ALBUM"), name: name)
        case .track: return NowPlayingFrom(kind: L("PLAYING FROM PLAYLIST"), name: name)
        }
    }
}
