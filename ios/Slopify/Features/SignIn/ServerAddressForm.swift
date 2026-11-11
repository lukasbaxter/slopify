import SwiftUI

/// "Your Slopify server" (UI.md 2.12, mobile/App.js ServerForm): main + home address, probed
/// before any password goes anywhere. Plus servers found on this network (API.md 4.6).
struct ServerAddressForm: View {
    @Bindable var model: SignInModel
    @State private var browser = ServerBrowser()
    @State private var resolving: String?
    @FocusState private var focus: Field?
    @Environment(\.theme) private var theme

    private enum Field { case main, home }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(L("Your Slopify server")).textStyle(.titleSm).foregroundStyle(theme.fg)
                        .padding(.bottom, 24)
                    label(L("Server address"))
                    field($model.main, placeholder: "music.example.com", focus: .main)
                    hint(L("With or without https:// in front. Slopify works it out."))
                    ForEach(browser.found) { f in found(f) }
                    label(L("Home network address"))
                    field($model.home, placeholder: L("Filled in for you after you sign in"), focus: .home)
                    hint(L("At home, Slopify streams straight over your Wi-Fi from this address, and switches by itself when you leave. Leave it empty to always use the server address."))
                    if let e = model.serverError {
                        Text(e).font(.system(size: 14)).foregroundStyle(theme.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.bottom, 16)
                    }
                    buttons
                }
                .frame(maxWidth: 480)
                .padding(.horizontal, 24).padding(.vertical, 64)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .onAppear {
            browser.start()
            if model.main.isEmpty { focus = .main }
        }
        .onDisappear { browser.stop() }
    }

    private func label(_ s: String) -> some View {
        Text(s).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.fg).padding(.bottom, 8)
    }

    private func hint(_ s: String) -> some View {
        Text(s).font(.system(size: 13)).lineSpacing(5).foregroundStyle(theme.fgDim)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 20)
    }

    private func field(_ text: Binding<String>, placeholder: String, focus f: Field) -> some View {
        TextField("", text: text, prompt: Text(placeholder).foregroundStyle(theme.fgFaint))
            .font(.system(size: 16)).foregroundStyle(theme.fg).tint(theme.fg)
            .keyboardType(.URL).textContentType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit(connect)
            .focused($focus, equals: f)
            .disabled(model.probing)
            .padding(12)
            .background(theme.field, in: RoundedRectangle(cornerRadius: Radius.row))
            .overlay(RoundedRectangle(cornerRadius: Radius.row).strokeBorder(Theme.Fixed.fieldBorder, lineWidth: 1))
            .padding(.bottom, 20)
    }

    /// Same look as the shell's "Away from home ... Use it" suggestion.
    private func found(_ f: ServerBrowser.Found) -> some View {
        Button {
            guard resolving == nil else { return }
            resolving = f.id
            Task {
                if let url = await ServerBrowser.resolve(f.endpoint) { model.use(url) }
                resolving = nil
            }
        } label: {
            (Text(L("{name} is on this network. ", ["name": f.name])).foregroundStyle(theme.fgDim)
             + Text(L("Use it")).bold().foregroundStyle(theme.green))
                .font(.system(size: 13)).lineSpacing(5)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .opacity(resolving == f.id ? 0.6 : 1)
        }
        .buttonStyle(.pressFade)
        .disabled(model.probing)
        .padding(.top, -8).padding(.bottom, 20)
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            if model.canCancelServer {
                Button(L("Cancel")) { model.cancelServerEdit() }
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.fgDim)
                    .padding(.vertical, 10).padding(.horizontal, 16)
                    .buttonStyle(.pressFade)
                    .disabled(model.probing)
            }
            Button(action: connect) {
                ZStack {
                    Text(L("Connect")).font(.system(size: 14, weight: .bold)).opacity(model.probing ? 0 : 1)
                    if model.probing { ProgressView().tint(theme.onAccent) }
                }
                .foregroundStyle(theme.onAccent)
                .padding(.vertical, 10).padding(.horizontal, 22)
                .background(theme.green, in: Capsule())
                .opacity(model.probing ? 0.6 : 1)
            }
            .buttonStyle(.pressFade)
            .disabled(model.probing)
        }
    }

    private func connect() {
        focus = nil
        Task { await model.connect() }
    }
}
