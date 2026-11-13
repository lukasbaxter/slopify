import SwiftUI
import UIKit

/// "Already added" (API.md 8.2): asks whether a song already in the playlist goes in again.
/// Drawn in its own window like the toasts, so it shows over now playing and open sheets too.
/// `LibraryStore.add` is the only caller.
///
///     let a = await DuplicateDialog.shared.ask(song: t.title, playlist: p.name, showAll: left > 1)
@MainActor @Observable
final class DuplicateDialog {
    static let shared = DuplicateDialog()

    struct Question: Identifiable, Equatable {
        let id = UUID()
        var song: String
        var playlist: String
        /// More than one duplicate left: the "Do this for all" box shows.
        var showAll: Bool
    }

    private(set) var question: Question?
    var forAll = false

    @ObservationIgnored private var pending: CheckedContinuation<PlaylistAdd.Answer, Never>?
    @ObservationIgnored private var window: UIWindow?

    func ask(song: String, playlist: String, showAll: Bool) async -> PlaylistAdd.Answer {
        answer(add: false) // a question still open is a Don't add
        forAll = false
        question = Question(song: song, playlist: playlist, showAll: showAll)
        show()
        return await withCheckedContinuation { pending = $0 }
    }

    /// The buttons; closing the dialog is `answer(add: false)`.
    func answer(add: Bool) {
        let c = pending
        pending = nil
        let all = question?.showAll == true && forAll
        question = nil
        window?.isHidden = true
        c?.resume(returning: PlaylistAdd.Answer(add: add, forAll: all))
    }

    private func show() {
        if window == nil {
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive })
                    ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
                answer(add: false)
                return
            }
            let w = UIWindow(windowScene: scene)
            w.windowLevel = .alert
            w.backgroundColor = .clear
            let host = UIHostingController(rootView: DuplicateDialogView(center: self))
            host.view.backgroundColor = .clear
            w.rootViewController = host
            window = w
        }
        window?.isHidden = false
    }
}

/// The name prompt's card (Dialogs.swift): 60 % scrim (tap = Don't add), `--bg-elevated-hi`,
/// radius 8, padding 24, width `min(420, screen - 32)`, gap 16; Don't add (outlined), Add anyway (pill).
private struct DuplicateDialogView: View {
    @Bindable var center: DuplicateDialog

    var body: some View {
        GeometryReader { g in
            ZStack {
                if let q = center.question {
                    Theme.Fixed.sheetScrim.ignoresSafeArea()
                        .onTapGesture { center.answer(add: false) }
                    card(q).frame(width: min(420, g.size.width - 32))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .environment(\.theme, ToastCenter.shared.theme)
    }

    private func card(_ q: DuplicateDialog.Question) -> some View {
        DuplicateDialogCard(question: q, forAll: $center.forAll, answer: { center.answer(add: $0) })
    }
}

private struct DuplicateDialogCard: View {
    let question: DuplicateDialog.Question
    @Binding var forAll: Bool
    var answer: (Bool) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("Already added")).textStyle(.dialogTitle).foregroundStyle(theme.fg)
            Text(L("\"{song}\" is already in {name}.", ["song": question.song, "name": question.playlist]))
                .textStyle(.small).foregroundStyle(theme.fgSub)
                .fixedSize(horizontal: false, vertical: true)
            if question.showAll {
                Button { forAll.toggle() } label: {
                    HStack(spacing: 8) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 3).strokeBorder(forAll ? theme.fg : theme.fgSub, lineWidth: 1.5)
                                .background(forAll ? theme.fg : .clear, in: RoundedRectangle(cornerRadius: 3))
                            if forAll { IconView(.check, size: 14).foregroundStyle(theme.onFg) }
                        }
                        .frame(width: 18, height: 18)
                        Text(L("Do this for all")).textStyle(.small).foregroundStyle(theme.fg)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(forAll ? [.isSelected] : [])
            }
            HStack(spacing: 8) {
                Spacer()
                SecondaryButton(L("Don't add")) { answer(false) }
                PrimaryButton(L("Add anyway")) { answer(true) }
            }
        }
        .padding(24)
        .background(theme.bgElevatedHi, in: RoundedRectangle(cornerRadius: Radius.dialog))
        .shadow(color: .black.opacity(0.3), radius: 12, y: 16)
    }
}
