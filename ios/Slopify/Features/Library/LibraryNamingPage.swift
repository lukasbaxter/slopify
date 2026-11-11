import SwiftUI

/// What the full-screen naming page names (Sidebar.jsx `naming`).
struct LibraryNaming: Identifiable {
    enum Kind: Hashable { case playlist, folder, rename(id: String) }
    let id = UUID()
    var kind: Kind
    var name: String = ""

    var title: String {
        switch kind {
        case .playlist: L("Give your playlist a name")
        case .folder: L("Give your folder a name")
        case .rename: L("Rename folder")
        }
    }
    var placeholder: String { kind == .playlist ? L("My playlist #1") : L("My folder") }
    var confirm: String { if case .rename = kind { return L("Save") } else { return L("Create") } }
}

/// `.newpl` (UI.md 5.2.10): page colour, centred column gap 24, 24/700 title, a big centred
/// field with a bottom hairline, Cancel + white Create pill (30 % while blank). No animation.
struct LibraryNamingPage: View {
    let naming: LibraryNaming
    var close: (_ then: (() -> Void)?) -> Void
    var onSubmit: (LibraryNaming, String) -> Void

    @Environment(\.theme) private var theme
    @State private var text: String
    @FocusState private var focused: Bool

    init(naming: LibraryNaming, close: @escaping (_ then: (() -> Void)?) -> Void, onSubmit: @escaping (LibraryNaming, String) -> Void) {
        self.naming = naming; self.close = close; self.onSubmit = onSubmit
        _text = State(initialValue: naming.name)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 24) {
            Text(naming.title).textStyle(.pageTitle).foregroundStyle(theme.fg).multilineTextAlignment(.center)
            TextField("", text: $text, prompt: Text(naming.placeholder).foregroundStyle(theme.fgFaint))
                .font(.system(size: 24, weight: .bold)).foregroundStyle(theme.fg)
                .multilineTextAlignment(.center)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(submit)
                .padding(.top, 8).padding(.bottom, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(focused ? theme.fg : theme.fgFaint).frame(height: 1) }
                .frame(maxWidth: 340)
            HStack(spacing: 24) {
                Button { close(nil) } label: {
                    Text(L("Cancel")).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .buttonStyle(.pressFade)
                Button(action: submit) {
                    Text(naming.confirm).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.onFg)
                        .padding(.horizontal, 32).frame(minHeight: 48)
                        .background(theme.fg, in: Capsule())
                }
                .buttonStyle(.pressFade)
                .disabled(trimmed.isEmpty)
                .opacity(trimmed.isEmpty ? 0.3 : 1)
            }
            .padding(.top, -16) // 8 below the field
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.page.ignoresSafeArea())
        .onAppear { DispatchQueue.main.async { focused = true } }
    }

    private func submit() {
        let n = trimmed
        guard !n.isEmpty else { return }
        close { onSubmit(naming, n) }
    }
}
