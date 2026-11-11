import SwiftUI

/// What the album and artist pages share: the open sheet / dialog, the page error banner, and the
/// actions behind page menus. Track rows use the shared `TrackMenuBuilder`.
@MainActor @Observable
final class DetailActions {
    var menu: MenuSheet?
    var nameDialog: NameDialog?
    var confirm: ConfirmDialog?
    /// The page's error banner (`.banner.error`), tap to dismiss.
    var error: String?
    /// The user's playlists for page "Add to playlist" menus (the shared store).
    var playlists: [Playlist] { LibraryStore.shared.playlists }

    @ObservationIgnored weak var app: AppModel?

    var api: APIClient? { app?.account.api }
    var offline: Bool { Connectivity.shared.offline }

    func attach(_ app: AppModel) {
        self.app = app
    }

    // MARK: Playlists

    func refreshPlaylists() async {
        guard let menus else { return }
        await menus.attachedStore().refreshPlaylists()
    }

    /// Pages listen for this and re-read the playlists.
    private func libraryChanged() {
        NotificationCenter.default.post(name: .libraryChanged, object: nil)
    }

    // MARK: Track menu

    /// The shared track menu (TrackMenu); `remove` only on a user playlist's own page.
    var menus: TrackMenuBuilder? {
        guard let app else { return nil }
        return TrackMenuBuilder(app: app) { [weak self] d in self?.nameDialog = d }
    }

    func openTrackMenu(_ t: Track, remove: ((Track) -> Void)? = nil) {
        menu = menus?.sheet(t, remove: remove)
    }

    // MARK: Actions

    func radio(_ seedId: String) {
        guard let app else { return }
        Task { await app.player.startRadio(seedId: seedId, context: nil) }
    }

    /// "New playlist" from a page menu, seeded with the first song (shared prompt).
    func newPlaylist(seed: Track?) {
        guard let menus else { return }
        nameDialog = menus.newPlaylistDialog(seed: seed)
    }

    /// A page menu's "Add to playlist": one request with every id; failure shows as the banner.
    func addTo(_ p: Playlist, ids: [String]) {
        guard let api, !ids.isEmpty else { return }
        Task {
            do {
                try await api.addToPlaylist(p.id, trackIds: ids)
                ToastCenter.shared.show(L("Added to {name}", ["name": p.name]))
                self.libraryChanged()
            } catch {
                self.error = Self.message(error)
            }
        }
    }

    /// "Add to playlist" submenu of a page menu: New playlist (seeded with the first song) + the others.
    func playlistSub(tracks: [Track], excluding id: String? = nil) -> [MenuItem] {
        var sub: [MenuItem] = [MenuItem(L("New playlist"), icon: .plus) { [weak self] in
            self?.newPlaylist(seed: tracks.first)
        }]
        sub += playlists.filter { $0.id != id }.map { p in
            MenuItem(p.name) { [weak self] in self?.addTo(p, ids: tracks.map(\.id)) }
        }
        return sub
    }

    func share(_ kind: TrackMenu.ShareKind, id: String, title: String, by: String?) {
        guard let app else { return }
        TrackMenuBuilder.share(kind, id: id, title: title, by: by, account: app.account)
    }

    /// Tell other devices the library changed (album save), as the web does over the session.
    func announceLibraryChange() {
        app?.session.sendPrefs(["_libraryChanged": .number(Date().timeIntervalSince1970 * 1000)])
        NotificationCenter.default.post(name: .libraryChanged, object: nil)
    }

    static func message(_ e: Error) -> String { (e as? LocalizedError)?.errorDescription ?? e.localizedDescription }
}
