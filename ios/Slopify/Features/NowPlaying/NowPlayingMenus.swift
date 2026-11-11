import SwiftUI

/// The ⋯ track sheet of now playing (FullScreen.jsx:221-240; UI.md 3.2.7) and the queue row
/// sheet (UI.md 3.3.4 / 5.6.2). The ⋯ sheet is the shared `TrackMenu` in its now playing style
/// plus the sleep timer. Actions run after the sheet has closed.
@MainActor
struct NowPlayingMenus {
    let menus: TrackMenuBuilder
    /// Optimistic sleep state (the server echo replaces it).
    var sleep: (at: Double?, endOfTrack: Bool)?
    var setSleep: (SleepPick) -> Void = { _ in }

    enum SleepPick { case minutes(Int), endOfTrack, off }

    private var player: Player { menus.app.player }
    private var nav: Navigator { menus.app.nav }

    static func header(_ t: Track) -> MenuHeader {
        MenuHeader(art: .cover(NowPlayingCover.source(t)), title: t.title, subtitle: t.creditLine)
    }

    func nowPlaying(_ t: Track) -> MenuSheet {
        menus.sheet(t, style: .nowPlaying, header: Self.header(t), trailing: [sleepItem()])
    }

    /// Long-press on a queue row. `removable` is false on the Now-playing row.
    func queueRow(_ t: Track, at index: Int, removable: Bool) -> MenuSheet {
        let store = menus.attachedStore()
        let liked = menus.app.likes.isLiked(t.id)
        var items: [MenuItem] = []
        if removable { items.append(MenuItem(L("Remove from queue")) { player.removeFromQueue(at: index) }) }
        items.append(MenuItem(liked ? L("Remove from Liked Songs") : L("Add to Liked Songs")) { menus.like(t) })
        if !store.playlists.isEmpty {
            items.append(MenuItem(L("Add to playlist"), sub: store.playlists.map { p in
                MenuItem(p.name) { Task { await store.add([t.id], to: p) } }
            }))
        }
        items.append(.separator)
        if let id = t.artistIds.first { items.append(MenuItem(L("Go to artist")) { nav.open(.artist(id: id)) }) }
        if !t.albumId.isEmpty { items.append(MenuItem(L("Go to album")) { nav.open(.album(id: t.albumId)) }) }
        return MenuSheet(header: Self.header(t), items: MenuItem.tidy(items))
    }

    private func sleepItem() -> MenuItem {
        let z = sleep
        let label = NowPlayingMath.sleepLabel(at: z?.at, endOfTrack: z?.endOfTrack == true, now: Date().timeIntervalSince1970 * 1000)
        var sub: [MenuItem] = [5, 10, 15, 30, 45].map { m in MenuItem(L("{n} minutes", ["n": m])) { setSleep(.minutes(m)) } }
        sub.append(MenuItem(L("1 hour")) { setSleep(.minutes(60)) })
        sub.append(MenuItem(L("End of track")) { setSleep(.endOfTrack) })
        if z != nil {
            sub.append(.separator)
            sub.append(MenuItem(L("Turn off timer")) { setSleep(.off) })
        }
        return MenuItem(label, icon: .moon, sub: sub)
    }
}
