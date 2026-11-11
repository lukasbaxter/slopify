import Foundation

/// The real backend: `Account` for sign-in state, throwaway `APIClient`s for pre-sign-in calls.
@MainActor
final class AccountSignInBackend: SignInBackend {
    private let account: Account

    init(account: Account) { self.account = account }

    func probe(_ url: URL, timeout: TimeInterval) async -> Bool { await Account.probe(url, timeout: timeout) }

    func tryDemo(base: URL) async -> Bool { await account.tryDemo(base: base) }

    func signIn(base: URL, username: String, password: String) async throws {
        try await account.signIn(base: base, username: username, password: password)
    }

    func signIn(base: URL, main: URL, username: String, password: String) async throws {
        try await account.signIn(base: base, main: main, username: username, password: password)
    }

    /// Web Login: register, then the normal sign-in (so the token carries this device's name).
    func register(base: URL, invite: String, username: String, password: String) async throws {
        try await account.register(base: base, invite: invite, username: username, password: password)
    }

    func register(base: URL, main: URL, invite: String, username: String, password: String) async throws {
        try await account.register(base: base, main: main, invite: invite, username: username, password: password)
    }

    func changePassword(new: String) async throws {
        try await account.changePassword(current: nil, new: new)
    }

    func setHome(_ url: URL) { account.setHome(url, off: false) }
}
