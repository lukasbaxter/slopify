import SwiftUI

/// Everything before the shell (UI.md 2.12): server address, demo check, sign-in / invite
/// sign-up, and the forced first password (`Account.state == .passwordChange`).
struct SignInFlow: View {
    @Environment(Account.self) private var account

    var body: some View {
        SignInFlowContent(account: account)
    }
}

private struct SignInFlowContent: View {
    let account: Account
    @State private var model: SignInModel
    @Environment(\.theme) private var theme

    init(account: Account) {
        self.account = account
        _model = State(initialValue: SignInModel(backend: AccountSignInBackend(account: account)))
    }

    var body: some View {
        ZStack {
            theme.black.ignoresSafeArea()
            if account.state == .passwordChange {
                ChangePasswordView(model: model, name: account.user?.name)
            } else {
                switch model.stage {
                case .server: ServerAddressForm(model: model)
                case .starting: StartingView()
                case .login: LoginForm(model: model)
                }
            }
        }
        .preferredColorScheme(.dark)
        .task { await model.start() }
        .onOpenURL { url in Task { await model.acceptInvite(url) } }
    }
}

/// `.boot`: centred `Starting Slopify...` while the demo check runs.
private struct StartingView: View {
    @Environment(\.theme) private var theme
    var body: some View {
        Text(L("Starting Slopify...")).textStyle(.body).foregroundStyle(theme.fgDim)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
