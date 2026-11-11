import SwiftUI

/// Settings › Scrobbling (UI.md 7.2.3; web Library.jsx:756-781): ListenBrainz user and token.
/// The draft lives in memory only; the token is read from the account prefs, never stored here.
struct ScrobblingView: View {
    @Environment(Account.self) private var account
    @Environment(\.theme) private var theme
    @State private var draft: AccountSettingsLogic.ListenBrainz?
    @State private var savedFlash = false
    @State private var flashTask: Task<Void, Never>?
    @FocusState private var focus: Field?

    enum Field: Hashable { case user, token }

    var body: some View {
        let saved = AccountSettingsLogic.ListenBrainz(prefs: account.prefs)
        let d = draft ?? saved
        AccountSettingsScaffold(title: L("Scrobbling"), chevron: 22, topPadding: 8) {
            AccountSettingsCaption(L("Every song you play for at least half its length is sent to ListenBrainz as a listen. Get the token from listenbrainz.org, under Settings."))

            field(L("ListenBrainz username"), focused: focus == .user) {
                TextField("", text: binding(\.user, d), prompt: Text(L("username")).foregroundColor(theme.fgFaint))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.username)
                    .focused($focus, equals: .user)
                    .submitLabel(.next)
                    .onSubmit { focus = .token }
            }
            field(L("ListenBrainz user token"), focused: focus == .token) {
                SecureField("", text: binding(\.token, d), prompt: Text(verbatim: "xxxxxxxx-xxxx-…").foregroundColor(theme.fgFaint))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .token)
                    .submitLabel(.done)
                    .onSubmit { if AccountSettingsLogic.scrobblingDirty(draft: d, saved: saved) { submit(d) } }
            }

            let dirty = AccountSettingsLogic.scrobblingDirty(draft: d, saved: saved)
            Button { submit(d) } label: {
                Text(savedFlash ? L("Saved") : L("Save"))
                    .font(.system(size: 16, weight: .bold)).foregroundStyle(theme.onAccent)
                    .padding(.horizontal, 40).frame(minHeight: 48)
                    .background(theme.accent, in: Capsule())
            }
            .buttonStyle(.pressFade)
            .disabled(!dirty)
            .opacity(dirty ? 1 : 0.3)
            .frame(maxWidth: .infinity)
            .padding(.top, 8).padding(.bottom, 16)

            AccountSettingsCaption(AccountSettingsLogic.scrobblingStatus(saved))

            if saved.connected {
                Button {
                    focus = nil
                    draft = nil
                    Task { await account.patchPrefs(["listenbrainz": AccountSettingsLogic.ListenBrainz().prefValue]) }
                } label: {
                    Text(L("Disconnect")).font(.system(size: 14, weight: .bold)).foregroundStyle(theme.fg)
                        .padding(.vertical, 12).padding(.horizontal, 16)
                }
                .buttonStyle(.pressFade)
                .frame(maxWidth: .infinity)
            }
        }
        .onDisappear { flashTask?.cancel() }
    }

    private func binding(_ key: WritableKeyPath<AccountSettingsLogic.ListenBrainz, String>, _ current: AccountSettingsLogic.ListenBrainz) -> Binding<String> {
        Binding(get: { (draft ?? current)[keyPath: key] }, set: { v in
            var d = draft ?? current
            d[keyPath: key] = v
            draft = d
        })
    }

    private func field<F: View>(_ label: String, focused: Bool, @ViewBuilder input: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
            input()
                .font(.system(size: 16))
                .foregroundStyle(theme.fg)
                .padding(.horizontal, 12)
                .frame(height: 48)
                .background(theme.chip, in: RoundedRectangle(cornerRadius: 4))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(focused ? theme.fgDim : .clear, lineWidth: 1))
        }
        .padding(.bottom, 16)
    }

    private func submit(_ d: AccountSettingsLogic.ListenBrainz) {
        focus = nil
        let clean = AccountSettingsLogic.scrobblingSubmit(d)
        Task {
            await account.patchPrefs(["listenbrainz": clean.prefValue])
            draft = nil
            savedFlash = true
            flashTask?.cancel()
            flashTask = Task {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if !Task.isCancelled { savedFlash = false }
            }
        }
    }
}
