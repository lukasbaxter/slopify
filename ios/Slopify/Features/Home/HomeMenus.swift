import SwiftUI

/// The mix page's ⋯ sheet (UI.md 5.6.1, Mix column). Track rows use the shared `TrackMenuBuilder`.
@MainActor
struct HomeMenus {
    let menus: TrackMenuBuilder

    private var player: Player { menus.app.player }

    /// `radioSeed`: the Daily Mix's artist; nil hides "Go to radio" (a Top Songs year has no seed).
    func mixPage(title: String, art: CoverSource?, tracks: [Track], radioSeed: String?) -> MenuSheet {
        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: true) { if !tracks.isEmpty { player.addToQueue(tracks) } },
        ]
        if let radioSeed {
            items.append(MenuItem(L("Go to radio"), icon: .radio) { Task { await player.startRadio(seedId: radioSeed, context: nil) } })
        }
        if let first = tracks.first {
            let store = menus.attachedStore()
            // One POST with every id, one toast (App.jsx onAddTo); New playlist is seeded with the first song.
            let sub = TrackMenu.playlistSub(store.playlists, new: { menus.askName(menus.newPlaylistDialog(seed: first)) },
                                            add: { p in Task { await store.add(tracks.map(\.id), to: p) } })
            items.append(MenuItem(L("Add to playlist"), icon: .plus, sub: sub))
        }
        let shown = TrackMenuBuilder.offline ? MenuItem.offlineSubset(items) : MenuItem.tidy(items)
        let header = MenuHeader(art: art.map { .cover($0) } ?? .icon(.musicNote), title: title, subtitle: L("Playlist"))
        return MenuSheet(header: header, items: shown)
    }
}
