import Foundation
import Network
import UIKit

/// The signed-in account: server addresses, token, user, prefs. Owns the APIClient and
/// moves it between the main and the home address (API.md §4.4).
@MainActor @Observable
final class Account {
    struct Saved: Codable {
        var main: String
        var home: String?
        var homeAuto: Bool = true
        var homeOff: Bool = false
        var token: String
        var user: User
        var key: String?       // /api/server/addresses key, for the home proof
        var demo: Bool = false
    }

    enum State: Equatable { case signedOut, passwordChange, signedIn }

    private(set) var state: State = .signedOut
    private(set) var user: User?
    private(set) var saved: Saved?
    /// Base the app is using right now (main or home).
    private(set) var activeBase: URL?
    var onHome: Bool { saved?.home != nil && activeBase?.absoluteString == saved?.home }
    /// Shallow prefs object (API.md §16). Unknown keys are kept.
    private(set) var prefs: [String: JSONValue] = [:]

    let api: APIClient
    /// Called after the base URL moves (the session reconnects there).
    var onBaseChanged: ((URL) -> Void)?
    /// Called after a prefs patch from this device, to relay it on the socket.
    var onPrefsPatched: (([String: JSONValue]) -> Void)?

    private let monitor = NWPathMonitor()
    private var path: NWPath?
    private static let key = "account"

    init() {
        api = APIClient(baseURL: URL(string: "http://localhost")!)
        api.onUnauthorized = { [weak self] in self?.signedOutRemotely() }
        api.onPasswordChangeRequired = { [weak self] in self?.state = .passwordChange }
        if let s = Keychain.load(Saved.self, for: Self.key), let main = URL(string: s.main) {
            saved = s; user = s.user
            api.baseURL = main; api.token = s.token; activeBase = main
            state = s.user.mustChangePassword == true ? .passwordChange : .signedIn
        }
        api.onReachability = { reachable in Connectivity.shared.note(reachable: reachable) }
        Connectivity.shared.healthCheck = { [weak self] timeout in
            guard let self, let base = self.activeBase else { return false }
            return await APIClient(baseURL: base, session: self.api.session).healthzOK(timeout: timeout)
        }
        monitor.pathUpdateHandler = { [weak self] p in
            Task { @MainActor in
                self?.path = p
                Connectivity.shared.pathChanged(satisfied: p.status == .satisfied)
                await self?.chooseAddress()
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    static var deviceName: String { UIDevice.current.name.isEmpty ? UIDevice.current.model : UIDevice.current.name }

    // MARK: sign in / out

    /// UI.md 2.12: 6 s for the main address, 3 s for home.
    nonisolated static let mainProbeTimeout: TimeInterval = 6
    nonisolated static let homeProbeTimeout: TimeInterval = 3

    /// Finds a Slopify server at what the user typed: every scheme guess probed in parallel,
    /// the first in guess order that answers wins.
    func findServer(_ typed: String, timeout: TimeInterval = Account.mainProbeTimeout) async -> URL? {
        await Self.findServer(typed, timeout: timeout) { await Account.probe($0, timeout: $1) }
    }

    static func findServer(_ typed: String, timeout: TimeInterval,
                           probe: @escaping @MainActor @Sendable (URL, TimeInterval) async -> Bool) async -> URL? {
        let tries = Address.candidates(typed)
        guard !tries.isEmpty else { return nil }
        var ok = Array(repeating: false, count: tries.count)
        await withTaskGroup(of: (Int, Bool).self) { g in
            for (i, u) in tries.enumerated() { g.addTask { (i, await probe(u, timeout)) } }
            for await (i, r) in g { ok[i] = r }
        }
        return ok.firstIndex(of: true).map { tries[$0] }
    }

    /// `GET {url}/api/healthz` answers `{ok: true}` within `timeout`.
    static func probe(_ url: URL, timeout: TimeInterval) async -> Bool {
        await APIClient(baseURL: url).healthzOK(timeout: timeout)
    }

    /// Signs in through `base`. `main` is the address to keep as the server address when it
    /// differs from `base` (set up at home: only the home address answered); `base` is then
    /// kept as the home address.
    func signIn(base: URL, main: URL? = nil, username: String, password: String) async throws {
        api.baseURL = base; api.token = nil
        let r = try await api.login(username: username, password: password, device: Self.deviceName)
        adopt(r, base: base, main: main ?? base)
    }

    /// Invite sign-up, then the normal sign-in so the token carries this device's name.
    func register(base: URL, main: URL? = nil, invite: String, username: String, password: String) async throws {
        _ = try await APIClient(baseURL: base).register(invite: invite, username: username, password: password)
        try await signIn(base: base, main: main, username: username, password: password)
    }

    /// Demo servers hand out a guest; nil on a normal server.
    func tryDemo(base: URL) async -> Bool {
        api.baseURL = base
        guard let r = try? await api.demoSignIn(device: Self.deviceName) else { return false }
        adopt(r, base: base); return true
    }

    private func adopt(_ r: LoginResponse, base: URL, main: URL? = nil) {
        let main = main ?? base
        let viaHome = Address.origin(main) != Address.origin(base) || main.path != base.path
        let s = Saved(main: main.absoluteString, home: viaHome ? base.absoluteString : nil, homeAuto: !viaHome,
                      token: r.token, user: r.user, demo: r.demo ?? false)
        saved = s; user = r.user; api.token = r.token; activeBase = base
        Keychain.save(s, for: Self.key)
        state = r.user.mustChangePassword == true ? .passwordChange : .signedIn
        Task { await refreshAfterSignIn() }
    }

    func changePassword(current: String?, new: String) async throws {
        try await api.changePassword(current: current, new: new)
        user?.mustChangePassword = false
        if var s = saved { s.user.mustChangePassword = false; saved = s; Keychain.save(s, for: Self.key) }
        state = .signedIn
        await refreshAfterSignIn()
    }

    /// Web App.jsx `logOut`: the session goes at once; the logout call runs on its own
    /// (offline it would otherwise hold the button for the whole request timeout).
    func signOut() async {
        let ending = APIClient(baseURL: api.baseURL, token: api.token, session: api.session)
        clear()
        Task { try? await ending.logout() }
    }

    private func signedOutRemotely() { clear() }
    /// The socket said the token is dead (4003).
    func signedOutBySession() { clear() }

    private func clear() {
        Keychain.delete(Self.key)
        saved = nil; user = nil; prefs = [:]; api.token = nil; state = .signedOut
    }

    /// On launch and foreground: check the token, refresh addresses + prefs.
    func refreshAfterSignIn() async {
        guard state != .signedOut else { return }
        if let me = try? await api.me() { user = me; if var s = saved { s.user = me; saved = s; Keychain.save(s, for: Self.key) } }
        guard state == .signedIn else { return }
        if let a = try? await api.serverAddresses(), var s = saved {
            s.key = a.key
            if s.homeAuto, !s.homeOff, let lan = a.lan.flatMap(Address.normalise), Address.origin(lan) != Address.origin(URL(string: s.main)!) {
                s.home = lan.absoluteString
            }
            saved = s; Keychain.save(s, for: Self.key)
        }
        if let p = try? await api.prefs() { prefs = p }
        await chooseAddress()
    }

    // MARK: home / main

    func setHome(_ url: URL?, off: Bool) {
        guard var s = saved else { return }
        s.home = url?.absoluteString; s.homeAuto = url == nil && !off; s.homeOff = off
        saved = s; Keychain.save(s, for: Self.key)
        Task { await chooseAddress() }
    }

    /// API.md §4.4: use home when it proves itself, else main.
    func chooseAddress() async {
        guard let s = saved, state == .signedIn, let main = URL(string: s.main) else { return }
        var target = main
        if !s.homeOff, let homeS = s.home, let home = URL(string: homeS), let key = s.key {
            let cellularOnly = path?.usesInterfaceType(.cellular) == true && path?.usesInterfaceType(.wifi) != true && path?.usesInterfaceType(.wiredEthernet) != true
            if !(cellularOnly && Address.isLANOnly(home)),
               await HomeProof.check(home: home, userId: s.user.id, keyHex: key, timeout: 1.5) {
                target = home
            }
        }
        if target != activeBase {
            activeBase = target; api.baseURL = target
            onBaseChanged?(target)
        }
    }

    // MARK: prefs

    func pref(_ key: String) -> JSONValue? { prefs[key] }

    /// Shallow patch: top-level keys replace. Nested objects must be passed whole (API.md §16).
    /// A failed PATCH is dropped; `patchPrefsThrowing` reports it.
    func patchPrefs(_ patch: [String: JSONValue]) async {
        try? await patchPrefsThrowing(patch)
    }

    /// Shown and relayed at once; the server's error comes back (the local value stays, as on
    /// the web, which toasts 'Could not save settings: {error}').
    func patchPrefsThrowing(_ patch: [String: JSONValue]) async throws {
        for (k, v) in patch { prefs[k] = v }
        onPrefsPatched?(patch)
        prefs = try await api.patchPrefs(patch)
    }

    /// A patch from another device (socket `prefs`).
    func applyRemotePrefs(_ patch: [String: JSONValue]) {
        for (k, v) in patch where !k.hasPrefix("_") { prefs[k] = v }
    }
}
