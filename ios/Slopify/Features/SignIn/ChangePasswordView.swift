import SwiftUI

/// "Choose a new password" (web/src/App.jsx ChangePassword): the sign-in page style, no logo.
/// Nothing else works until it is done (API.md 3.4).
struct ChangePasswordView: View {
    @Bindable var model: SignInModel
    let name: String?
    @FocusState private var focus: Field?

    private enum Field { case new, again }

    var body: some View {
        LoginPage {
            LoginHeading(title: L("Choose a new password"),
                         subtitle: L("The default password only opens this page. Pick a new one for {name}.", ["name": name.flatMap { $0.isEmpty ? nil : $0 } ?? L("this account")]))
            LoginLabeled(title: L("New password")) {
                SecureField("", text: $model.newPassword)
                    .textFieldStyle(LoginFieldStyle(focused: focus == .new))
                    .focused($focus, equals: .new)
                    .textContentType(.newPassword)
                    .submitLabel(.next)
                    .onSubmit { focus = .again }
            }
            LoginLabeled(title: L("Again")) {
                SecureField("", text: $model.again)
                    .textFieldStyle(LoginFieldStyle(focused: focus == .again))
                    .focused($focus, equals: .again)
                    .textContentType(.newPassword)
                    .submitLabel(.go)
                    .onSubmit(submit)
            }
            if let e = model.passwordError { ErrorBanner(message: e) }
            LoginButton(title: model.saving ? L("Saving…") : L("Save and continue"), enabled: model.canSavePassword, action: submit)
        }
        .onAppear { focus = .new }
    }

    private func submit() {
        guard model.canSavePassword else { return }
        Task { await model.savePassword() }
    }
}
