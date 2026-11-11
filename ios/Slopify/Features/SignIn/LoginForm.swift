import SwiftUI

/// Sign-in form (web/src/App.jsx Login, phone CSS app.css:1394-1406). With an invite code it is
/// the sign-up form.
struct LoginForm: View {
    @Bindable var model: SignInModel
    @FocusState private var focus: Field?
    @Environment(\.theme) private var theme

    private enum Field { case username, password }

    var body: some View {
        LoginPage {
            IconView(.loginMark, size: 40).foregroundStyle(theme.fg)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
                .accessibilityHidden(true)
            LoginHeading(title: "Slopify", subtitle: L("Your library, on any speaker in the house."))
            LoginLabeled(title: L("Username")) {
                TextField("", text: $model.username)
                    .textFieldStyle(LoginFieldStyle(focused: focus == .username))
                    .focused($focus, equals: .username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            LoginLabeled(title: L("Password")) {
                SecureField("", text: $model.password)
                    .textFieldStyle(LoginFieldStyle(focused: focus == .password))
                    .focused($focus, equals: .password)
                    .textContentType(model.invite == nil ? .password : .newPassword)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }
            if let e = model.loginError { ErrorBanner(message: e) }
            if model.invite != nil {
                Text(L("You have been invited. Pick a username and a password (8 characters or more)."))
                    .font(.system(size: 12)).foregroundStyle(theme.fgDim)
                    .padding(.top, 2)
            }
            LoginButton(title: buttonTitle, enabled: model.canLogIn, action: submit)
            // Native only: the web phone page has no server field; the shell reached its server
            // screen from Settings. This is the way back before signing in.
            Button(L("Server address")) { model.editServer() }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.fgDim)
                .buttonStyle(.pressFade)
                .frame(maxWidth: .infinity)
                .disabled(model.busy)
        }
        .onAppear { focus = .username }
    }

    private var buttonTitle: String {
        if model.invite != nil { return model.busy ? L("Creating account…") : L("Create account") }
        return model.busy ? L("Logging in…") : L("Log in")
    }

    private func submit() {
        guard model.canLogIn else { return }
        Task { await model.logIn() }
    }
}
