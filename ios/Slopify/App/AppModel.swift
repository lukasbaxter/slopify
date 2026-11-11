import SwiftUI

/// Owns the long-lived objects and wires them together. Injected into the environment.
@MainActor @Observable
final class AppModel {
    let account = Account()
    let session = SessionClient()
    let player = Player()
    let likes = Likes()
    let nav = Navigator()
    /// Your Library's data (playlists, saved albums, followed artists, layout) for every screen.
    let library: LibraryStore
    /// Songs kept on this device ("Download for offline").
    let offline = OfflineStore()
    let themeStore: ThemeStore

    private var started = false

    init() {
        themeStore = ThemeStore(account: account)
        library = LibraryStore()
        LibraryStore.shared = library
        library.onLibraryChanged = { [weak self] in
            self?.session.sendPrefs(["_libraryChanged": .number(Date().timeIntervalSince1970 * 1000)])
        }
        OfflineStore.shared = offline
        player.localFile = { [weak offline] id in offline?.localFile(id) }
        player.onOfflinePlay = { [weak offline] id, at in offline?.recordPlay(id, at: at) }
        offline.onFinished = { ToastCenter.shared.show(OfflineRules.finishedText($0), seconds: 5) }
        Connectivity.shared.onChange = { [weak offline] off in
            ToastCenter.shared.offline = off
            if !off { offline?.wentOnline() }
        }
        ToastCenter.shared.offline = Connectivity.shared.offline
        ToastCenter.shared.themeStore = themeStore
        Localizer.shared.follow(account)
        account.onBaseChanged = { [weak self] base in self?.session.move(to: base) }
        account.onPrefsPatched = { [weak self] patch in self?.session.sendPrefs(patch) }
        session.onLike = { [weak self] id, liked in self?.likes.remote(id, liked: liked) }
        session.onPrefs = { [weak self] patch in
            self?.account.applyRemotePrefs(patch)
            // The patch rides along so the library store can skip its own layout rev.
            if patch["_libraryLayout"] != nil || patch["_libraryChanged"] != nil { NotificationCenter.default.post(name: .libraryChanged, object: patch) }
        }
        session.onSignedOut = { [weak self] in self?.account.signedOutBySession() }
        likes.attach(account.api)
        player.likes = likes
        player.attach(account: account, session: session)
        // Follows sign-in itself: resumes this account's unfinished jobs, forgets them on sign-out.
        LyricJobStore.shared.attach(account)
    }

    /// Call when signed in (launch, after sign-in, foreground).
    func start() async {
        guard account.state == .signedIn, let token = account.api.token else { return }
        library.attach(api: account.api, userId: account.user?.id)
        if let main = account.saved?.main, let uid = account.user?.id {
            let account = account
            offline.attach(api: account.api, server: OfflineStore.serverKey(main), userId: uid, prefs: { account.prefs })
        }
        if !started, let base = account.activeBase {
            started = true
            session.connect(base: base, token: token)
        }
        await account.refreshAfterSignIn()
        await Localizer.shared.refreshServerDefault(api: account.api)
        await likes.refresh()
        // After the first answers, so a launch with no network does not count songs as failed.
        offline.resume()
        await offline.flushPlays()
    }

    /// Signed out: nothing of the last account stays in memory (App.jsx `signOut`).
    func stop() {
        started = false
        session.disconnect()
        nav.reset()
        likes.reset()
        library.attach(api: account.api, userId: nil)
        offline.detach()
        Connectivity.shared.reset()
    }
}

extension Notification.Name {
    /// Playlists / layout changed on another device: re-fetch the library. `object` is the
    /// socket's prefs patch (`[String: JSONValue]`) when it came from there, else nil.
    static let libraryChanged = Notification.Name("slopify.libraryChanged")
}
