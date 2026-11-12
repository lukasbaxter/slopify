import SwiftUI

/// Long-press menus for album, artist and playlist cards and tiles (owner 11-12: a long press opens
/// the menu on everything that has actions, like a track row). The items are Your Library's.
///
///     @State private var menu: MenuSheet?
///     MediaCard(...) { open() } onLongPress: { menu = CardMenuBuilder(app: app).album(a.id, ...) }
///     .contextMenuSheet($menu)
@MainActor
struct CardMenuBuilder {
    let app: AppModel

    func album(_ id: String, name: String, artist: String?, artistId: String?) -> MenuSheet {
        let app = app
        let songs: () async -> [Track] = { (try? await app.account.api.album(id).tracks) ?? [] }
        var items = playItems(context: id, songs)
        if let artistId, !artistId.isEmpty { items.append(MenuItem(L("Go to artist")) { app.nav.open(.artist(id: artistId)) }) }
        items.append(MenuItem(L("Share")) { TrackMenuBuilder.share(.album, id: id, title: name, by: artist, account: app.account) })
        return MenuSheet(header: MenuHeader(art: .cover(.album(id: id, art: nil)), title: name, subtitle: artist), items: items)
    }

    func artist(_ id: String, name: String) -> MenuSheet {
        let app = app
        let songs: () async -> [Track] = {
            let mix = (try? await app.account.api.mix(id, limit: 100, mode: "radio").items) ?? []
            return StreamPolicy.dropDisliked(mix, prefs: app.account.prefs)
        }
        var items = playItems(context: id, songs)
        items.append(MenuItem(L("Share")) { TrackMenuBuilder.share(.artist, id: id, title: name, by: nil, account: app.account) })
        return MenuSheet(header: MenuHeader(art: .cover(.artist(id: id, image: nil), round: true), title: name), items: items)
    }

    func playlist(_ id: String, name: String) -> MenuSheet {
        let app = app
        let songs: () async -> [Track] = { (try? await app.account.api.playlist(id).tracks) ?? [] }
        return MenuSheet(header: MenuHeader(title: name), items: playItems(context: id, songs))
    }

    func likedSongs() -> MenuSheet {
        let app = app
        let songs: () async -> [Track] = { (try? await app.account.api.likes(full: true).items) ?? [] }
        return MenuSheet(header: MenuHeader(art: .liked, title: L("Liked Songs")), items: playItems(context: "liked", songs))
    }

    private func playItems(context: String, _ songs: @escaping () async -> [Track]) -> [MenuItem] {
        let player = app.player
        return [
            MenuItem(L("Add to queue")) { Task { let t = await songs(); if !t.isEmpty { player.addToQueue(t) } } },
            MenuItem(L("Play")) { Task { let t = await songs(); if !t.isEmpty { player.play(t, startAt: 0, context: context) } } },
            .separator,
        ]
    }
}
