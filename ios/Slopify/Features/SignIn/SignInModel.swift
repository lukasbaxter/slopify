import Foundation
import Observation

/// What the sign-in flow needs from the outside world. `Account` in the app, fakes in tests.
@MainActor
protocol SignInBackend: AnyObject {
    /// `GET {url}/api/healthz` answers `{ok: true}` within `timeout`.
    func probe(_ url: URL, timeout: TimeInterval) async -> Bool
    /// A demo server signs a guest straight in; false on a normal server.
    func tryDemo(base: URL) async -> Bool
    func signIn(base: URL, username: String, password: String) async throws
    func register(base: URL, invite: String, username: String, password: String) async throws
    /// Through `base` (the home address), keeping `main` as the server address.
    func signIn(base: URL, main: URL, username: String, password: String) async throws
    func register(base: URL, main: URL, invite: String, username: String, password: String) async throws
    func changePassword(new: String) async throws
    /// A home address typed before sign-in, applied once signed in.
    func setHome(_ url: URL)
}

extension SignInBackend {
    func signIn(base: URL, main: URL, username: String, password: String) async throws {
        try await signIn(base: base, username: username, password: password)
    }
    func register(base: URL, main: URL, invite: String, username: String, password: String) async throws {
        try await register(base: base, invite: invite, username: username, password: password)
    }
}

/// State of the sign-in flow (UI.md 2.12): server address, demo check, sign-in / sign-up form,
/// first password. The forced password screen itself follows `Account.state`.
@MainActor @Observable
final class SignInModel {
    enum Stage: Equatable { case server, starting, login }

    private(set) var stage: Stage = .server

    // Server address screen
    var main = ""
    var home = ""
    private(set) var serverError: String?
    private(set) var probing = false
    /// The answering server; set once the server screen succeeds (or from memory / an invite).
    private(set) var base: URL?
    /// Home address typed on the server screen, set on the account after sign-in.
    private(set) var pendingHome: URL?
    /// Set up at home: only the home address answered, so `base` is home and this is the
    /// typed main address, kept as the server address at sign-in.
    private(set) var awayMain: URL?

    // Sign-in form
    var username = ""
    var password = ""
    private(set) var loginError: String?
    private(set) var busy = false
    /// Invite code from an invite link: the form becomes sign-up.
    private(set) var invite: String?

    // First password
    var newPassword = ""
    var again = ""
    private(set) var passwordError: String?
    private(set) var saving = false

    /// Main probe 6 s, home 3 s (UI.md 2.12).
    static let mainTimeout: TimeInterval = 6
    static let homeTimeout: TimeInterval = 3
    static let rememberKey = "slopify.signin.server"

    private let backend: SignInBackend
    private let defaults: UserDefaults

    init(backend: SignInBackend, defaults: UserDefaults = .standard) {
        self.backend = backend
        self.defaults = defaults
        if let s = defaults.string(forKey: Self.rememberKey), let u = URL(string: s) {
            base = u
            main = s
        }
    }

    /// Cancel shows on the server screen only when a server is already known (editing).
    var canCancelServer: Bool { base != nil }
    var canLogIn: Bool { !busy && !username.isEmpty }
    var canSavePassword: Bool { !saving && !newPassword.isEmpty }

    /// First appearance: a remembered server goes straight to the demo check and the form.
    func start() async {
        guard stage == .server, base != nil, !probing else { return }
        await enter()
    }

    // MARK: server address

    func connect() async {
        guard !probing else { return }
        if let e = SignInRules.serverFormError(main: main, home: home) { serverError = e; return }
        probing = true; serverError = nil
        let typedHome = !home.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        async let m = find(main, timeout: Self.mainTimeout)
        async let h = typedHome ? find(home, timeout: Self.homeTimeout) : nil
        let (mFound, hFound) = await (m, h)
        probing = false
        // Either answering is enough: set up at home, main may only answer from outside.
        guard let found = mFound ?? hFound else { serverError = SignInRules.noServerMessage(typed: main); return }
        base = found
        pendingHome = hFound.flatMap { $0 == found ? nil : $0 }
        awayMain = mFound == nil ? Address.candidates(main).first.flatMap { $0 == found ? nil : $0 } : nil
        defaults.set(found.absoluteString, forKey: Self.rememberKey)
        if let awayMain { main = awayMain.absoluteString } else { main = found.absoluteString }
        await enter()
    }

    func editServer() {
        guard !busy else { return }
        if let base { main = base.absoluteString }
        serverError = nil
        stage = .server
    }

    func cancelServerEdit() {
        guard base != nil, !probing else { return }
        serverError = nil
        stage = .login
    }

    /// A server found on the network: its address goes into the field (like "Use it").
    func use(_ address: URL) {
        main = address.absoluteString
        serverError = nil
    }

    /// Candidates tried in parallel; the first in guess order that answers wins.
    private func find(_ typed: String, timeout: TimeInterval) async -> URL? {
        let tries = Address.candidates(typed)
        guard !tries.isEmpty else { return nil }
        var ok = Array(repeating: false, count: tries.count)
        await withTaskGroup(of: (Int, Bool).self) { g in
            for (i, u) in tries.enumerated() { g.addTask { (i, await self.backend.probe(u, timeout: timeout)) } }
            for await (i, r) in g { ok[i] = r }
        }
        return ok.firstIndex(of: true).map { tries[$0] }
    }

    /// Demo check, then the form (web Login: `tryingDemo`). Invite links skip the demo check.
    private func enter() async {
        guard let base else { return }
        if invite == nil {
            stage = .starting
            if await backend.tryDemo(base: base) { return }
        }
        stage = .login
    }

    // MARK: invite

    func acceptInvite(_ url: URL) async {
        guard let link = SignInRules.invite(from: url) else { return }
        invite = link.code
        base = link.base; main = link.base.absoluteString; awayMain = nil
        defaults.set(link.base.absoluteString, forKey: Self.rememberKey)
        loginError = nil
        stage = .login
    }

    // MARK: sign in

    func logIn() async {
        guard canLogIn, let base else { return }
        busy = true; loginError = nil
        defer { busy = false }
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if let invite {
                if let awayMain { try await backend.register(base: base, main: awayMain, invite: invite, username: name, password: password) }
                else { try await backend.register(base: base, invite: invite, username: name, password: password) }
                self.invite = nil
            } else if let awayMain {
                try await backend.signIn(base: base, main: awayMain, username: name, password: password)
            } else {
                try await backend.signIn(base: base, username: name, password: password)
            }
            awayMain = nil
            password = ""
            if let pendingHome { backend.setHome(pendingHome); self.pendingHome = nil }
        } catch {
            loginError = SignInRules.message(for: error)
        }
    }

    // MARK: first password

    func savePassword() async {
        guard canSavePassword else { return }
        if let e = SignInRules.newPasswordError(newPassword, again: again) { passwordError = e; return }
        saving = true; passwordError = nil
        defer { saving = false }
        do {
            try await backend.changePassword(new: newPassword)
            newPassword = ""; again = ""
        } catch {
            passwordError = SignInRules.message(for: error)
        }
    }
}
