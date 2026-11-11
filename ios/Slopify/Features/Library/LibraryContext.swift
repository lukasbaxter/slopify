import SwiftUI

/// Everything the library screens act on, read from the environment once per view.
@MainActor
struct LibraryContext {
    let api: APIClient
    let account: Account
    let player: Player
    let likes: Likes
    let nav: Navigator
    let session: SessionClient
    var store: LibraryStore { .shared }
    var offline: Bool { Connectivity.shared.offline }

    /// Attach the shared store to this account and relay library changes to other devices.
    func attachStore() {
        store.attach(api: api, userId: account.user?.id)
        let session = session
        store.onLibraryChanged = { session.sendPrefs(["_libraryChanged": .number(Date().timeIntervalSince1970 * 1000)]) }
    }

    var pinned: [String] { account.pref("libraryPinned")?.array?.compactMap(\.string) ?? [] }

    func togglePin(_ id: String) {
        let next = LibraryArrangement.togglingPin(pinned, id: id)
        Task { await account.patchPrefs(["libraryPinned": .array(next.map(JSONValue.string))]) }
    }

    /// Play `tracks` from `index`, or toggle when that row is already the current track.
    /// Offline only downloaded songs play (the offline store filters the list).
    func play(_ tracks: [Track], at index: Int, context: String) {
        guard tracks.indices.contains(index) else { return }
        if player.current?.id == tracks[index].id && player.context == context { player.togglePlay(); return }
        if let offline = OfflineStore.shared { offline.play(tracks, at: index, context: context, player: player) }
        else { player.play(tracks, startAt: index, context: context) }
    }

    /// The detail-page play button: toggle when this page is the playing context.
    func playPage(_ tracks: [Track], context: String) {
        if player.context == context && player.current != nil { player.togglePlay(); return }
        guard !tracks.isEmpty else { return }
        if let offline = OfflineStore.shared { offline.playPage(tracks, context: context, player: player) }
        else { player.play(tracks, startAt: 0, context: context) }
    }

    func isPlayingPage(_ context: String) -> Bool { player.context == context && player.isPlaying }

    func toggleShuffle() { player.setShuffle(player.shuffle == .off ? .on : .off) }

    /// Share link `{main address}/?{kind}={id}` (UI.md 5.4.6).
    func share(kind: TrackMenu.ShareKind, id: String, title: String, by: String?) {
        TrackMenuBuilder.share(kind, id: id, title: title, by: by, account: account)
    }
}
