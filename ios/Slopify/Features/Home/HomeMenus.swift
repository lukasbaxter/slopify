import SwiftUI

/// The mix page's ⋯ sheet (UI.md 5.6.1, Mix column). Track rows use the shared `TrackMenuBuilder`.
@MainActor
struct HomeMenus {
    let menus: TrackMenuBuilder

    private var player: Player { menus.app.player }

    /// A page's Go to radio seed: the id, and its name for the radio page's title before it loads.
    struct RadioSeed: Hashable { var id: String; var name: String? }

    /// `radioSeed`: the Daily Mix's artist; nil hides "Go to radio" (a Top Songs year has no seed,
    /// a radio page is one). `refresh`: a radio page's Refresh.
    func mixPage(title: String, art: CoverSource?, tracks: [Track], radioSeed: RadioSeed?, refresh: (() -> Void)? = nil) -> MenuSheet {
        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: true) { if !tracks.isEmpty { player.addToQueue(tracks) } },
        ]
        if let refresh { items.append(MenuItem(L("Refresh"), icon: .radio) { refresh() }) }
        if let radioSeed {
            let nav = menus.app.nav
            items.append(MenuItem(L("Go to radio"), icon: .radio) { nav.open(.radio(seedId: radioSeed.id, name: radioSeed.name)) })
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
