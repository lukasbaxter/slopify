import SwiftUI

/// Wires `TrackMenu` to the app (App.jsx onLike, onExclude, onAddTo, onNewPlaylistWithTrack,
/// startMix, syncLyrics, shareItem). Playlists come from `LibraryStore.shared`, likes from
/// `Likes.toggle`, lyric jobs from `LyricJobStore.shared`.
///
///     @Environment(AppModel.self) private var app
///     @State private var menu: MenuSheet?
///     @State private var dialog: NameDialog?
///     ...
///     onMore: { menu = TrackMenuBuilder(app: app) { dialog = $0 }.sheet(t) }
///     ...
///     .contextMenuSheet($menu).nameDialog($dialog)
@MainActor
struct TrackMenuBuilder {
    let app: AppModel
    /// Presents the "New playlist" name prompt.
    var askName: (NameDialog) -> Void

    /// - `remove`: "Remove from this playlist" (a user playlist's own page).
    /// - `downloaded`: kept for offline, so "Add to queue" stays in the offline menu (the offline
    ///   store is asked too, so lists need not pass it).
    /// - `header` / `style` / `trailing`: the now playing ⋯ sheet.
    func sheet(_ t: Track, remove: ((Track) -> Void)? = nil, downloaded: Bool = false, style: TrackMenu.Style = .row,
               header: MenuHeader? = nil, trailing: [MenuItem] = []) -> MenuSheet {
        let store = attachedStore()
        if store.playlists.isEmpty { Task { await store.refreshPlaylists() } }
        let state = TrackMenu.State(track: t, liked: app.likes.isLiked(t.id),
                                    excluded: TrackMenu.isExcluded(t.id, prefs: app.account.prefs),
                                    downloaded: downloaded || app.offline.has(t.id),
                                    syncing: LyricJobStore.shared.isSyncing(t.id),
                                    offline: Self.offline, playlists: store.playlists, style: style, trailing: trailing)
        return MenuSheet(header: header ?? TrackMenu.header(t), items: TrackMenu.items(state, actions(remove: remove)))
    }

    func actions(remove: ((Track) -> Void)? = nil) -> TrackMenu.Actions {
        let app = app
        return TrackMenu.Actions(
            addToQueue: { t in app.player.addToQueue([t]) },
            newPlaylist: { t in askName(newPlaylistDialog(seed: t)) },
            addTo: { p, t in Task { await attachedStore().add([t], to: p) } },
            remove: remove,
            like: { t, _ in like(t) },
            exclude: { t, on in exclude(t, on) },
            radio: { t in app.nav.open(.radio(seedId: t.id, name: t.title)) },
            openArtist: { id in app.nav.open(.artist(id: id)) },
            openAlbum: { id in app.nav.open(.album(id: id)) },
            syncLyrics: { t in Task { await LyricJobStore.shared.sync(t, api: app.account.api) } },
            share: { t in share(.track, id: t.id, title: t.title, by: TrackMenu.shareBy(t)) }
        )
    }

    static var offline: Bool { Connectivity.shared.offline }

    // MARK: Actions

    /// "New playlist" (UI.md 5.4.7): prefilled with the seed's album, creates it with the seed.
    func newPlaylistDialog(seed: Track?) -> NameDialog {
        let store = attachedStore()
        return NameDialog(title: L("New playlist"), initial: TrackMenu.newPlaylistName(seed), confirm: L("Create")) { name in
            let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return }
            Task { await store.createPlaylist(name: name, with: seed) }
        }
    }

    /// App.jsx:1013-1028: optimistic toggle, toast, a reverted toggle says "Not saved".
    func like(_ t: Track) {
        let likes = app.likes
        let was = likes.isLiked(t.id)
        Task {
            do {
                try await likes.set(t.id, liked: !was)
                ToastCenter.shared.show(was ? L("Removed from Liked Songs") : L("Added to Liked Songs"))
            } catch {
                ToastCenter.shared.show(L("Not saved: {error}", ["error": String(error.localizedDescription.prefix(60))]))
            }
        }
    }

    /// App.jsx:1072-1080: `prefs.dislikes`, then the toast.
    func exclude(_ t: Track, _ excluded: Bool) {
        let account = app.account
        let map = TrackMenu.dislikes(account.prefs, setting: t.id, excluded: excluded, now: (Date().timeIntervalSince1970 * 1000).rounded())
        Task {
            await account.patchPrefs(["dislikes": .object(map)])
            ToastCenter.shared.show(excluded ? L("Excluded from your taste profile") : L("Included in your taste profile"))
        }
    }

    /// `shareItem` (TrackRow.jsx:38-57): the system share sheet with `{main}/?{kind}={id}`.
    func share(_ kind: TrackMenu.ShareKind, id: String, title: String, by: String?) {
        Self.share(kind, id: id, title: title, by: by, account: app.account)
    }

    static func share(_ kind: TrackMenu.ShareKind, id: String, title: String, by: String?, account: Account) {
        guard let main = account.saved?.main, let url = TrackMenu.shareURL(main: main, kind: kind, id: id) else {
            ToastCenter.shared.show(L("Could not copy the link")); return
        }
        ShareSheet.present(url: url, title: TrackMenu.shareTitle(title, by: by))
    }

    /// The shared playlists store, pointed at this account; library changes reach other devices.
    func attachedStore() -> LibraryStore {
        let store = LibraryStore.shared
        store.attach(api: app.account.api, userId: app.account.user?.id)
        if store.onLibraryChanged == nil {
            let session = app.session
            store.onLibraryChanged = { session.sendPrefs(["_libraryChanged": .number(Date().timeIntervalSince1970 * 1000)]) }
        }
        return store
    }
}
