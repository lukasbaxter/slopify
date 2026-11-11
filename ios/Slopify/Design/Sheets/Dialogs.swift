import SwiftUI

/// The name prompt (UI.md 2.10, 5.4.7): 60 % scrim (tap = cancel), centred card `--bg-elevated-hi`
/// radius 8, padding 24, width `min(420, screen - 32)`, gap 16; 20/700 title; text field with the
/// text selected on focus; Cancel (outlined) and the confirm pill (disabled while blank).
struct NameDialog: Identifiable {
    let id = UUID()
    var title: String
    var initial: String
    var confirm: String
    var placeholder: String = ""
    var onConfirm: (String) -> Void
}

/// A yes/no question (`window.confirm` in the web): a native alert with Cancel and the action.
struct ConfirmDialog: Identifiable {
    let id = UUID()
    var message: String
    var confirm: String
    var destructive = false
    var onConfirm: () -> Void
}

private struct NameDialogView: View {
    let dialog: NameDialog
    var dismiss: (_ then: (() -> Void)?) -> Void
    @Environment(\.theme) private var theme
    @State private var text: String
    @State private var appeared = false
    @FocusState private var focused: Bool

    init(dialog: NameDialog, dismiss: @escaping (_ then: (() -> Void)?) -> Void) {
        self.dialog = dialog; self.dismiss = dismiss
        _text = State(initialValue: dialog.initial)
    }

    private var blank: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        GeometryReader { g in
            ZStack {
                Theme.Fixed.sheetScrim.opacity(appeared ? 1 : 0).ignoresSafeArea()
                    .onTapGesture { dismiss(nil) }
                VStack(alignment: .leading, spacing: 16) {
                    Text(dialog.title).textStyle(.dialogTitle).foregroundStyle(theme.fg)
                    TextField("", text: $text, prompt: Text(dialog.placeholder))
                        .textFieldStyle(.slopify(focused: focused))
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(submit)
                        .onAppear { DispatchQueue.main.async { focused = true; selectAll() } }
                    HStack(spacing: 8) {
                        Spacer()
                        SecondaryButton(L("Cancel")) { dismiss(nil) }
                        PrimaryButton(dialog.confirm, action: submit).disabled(blank)
                    }
                }
                .padding(24)
                .frame(width: min(420, g.size.width - 32))
                .background(theme.bgElevatedHi, in: RoundedRectangle(cornerRadius: Radius.dialog))
                .shadow(color: .black.opacity(0.3), radius: 12, y: 16)
                .opacity(appeared ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { withAnimation(Motion.scrim) { appeared = true } }
    }

    private func submit() {
        guard !blank else { return }
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        dismiss { dialog.onConfirm(name) }
    }

    /// "All text selected on focus".
    private func selectAll() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            UIApplication.shared.sendAction(#selector(UIResponder.selectAll(_:)), to: nil, from: nil, for: nil)
        }
    }
}

extension View {
    /// Present a `NameDialog` (New playlist, rename folder ...).
    func nameDialog(_ dialog: Binding<NameDialog?>) -> some View {
        overlayCover(item: dialog) { d, dismiss in NameDialogView(dialog: d, dismiss: dismiss) }
    }

    /// Present a `ConfirmDialog` as a native alert.
    func confirmDialog(_ dialog: Binding<ConfirmDialog?>) -> some View {
        alert(dialog.wrappedValue?.message ?? "", isPresented: Binding(get: { dialog.wrappedValue != nil }, set: { if !$0 { dialog.wrappedValue = nil } }),
              presenting: dialog.wrappedValue) { d in
            Button(L("Cancel"), role: .cancel) {}
            Button(d.confirm, role: d.destructive ? .destructive : nil) { d.onConfirm() }
        }
    }
}

#Preview("Name dialog") {
    struct P: View {
        @State var d: NameDialog? = NameDialog(title: "New playlist", initial: "OK Computer", confirm: "Create") { _ in }
        @State var c: ConfirmDialog?
        var body: some View {
            VStack {
                Button("Name") { d = NameDialog(title: "New playlist", initial: "My Playlist", confirm: "Create") { _ in } }
                Button("Confirm") { c = ConfirmDialog(message: "Delete \"Road trip\"?", confirm: "Delete", destructive: true) {} }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.default.page)
            .nameDialog($d).confirmDialog($c)
        }
    }
    return P()
}
