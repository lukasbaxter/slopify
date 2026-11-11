import SwiftUI
import UIKit

/// Toasts, the offline pill and the lyric-sync pill (UI.md 2.9), drawn in their own
/// pass-through window so they sit above everything: the tab bar, the mini player and now
/// playing (DECISIONS: above the mini player, and above now playing when it is open).
///
///     ToastCenter.shared.show(L("Added to {name}", ["name": p.name]))
///     ToastCenter.shared.offline = true
///     ToastCenter.shared.layout = .shell(miniPlayer: true)   // the shell keeps this current
@MainActor @Observable
final class ToastCenter {
    static let shared = ToastCenter()

    /// Where the stack sits: above the mini player card, above the tab bar, or over now playing.
    enum Layout: Hashable, Sendable {
        case shell(miniPlayer: Bool)
        case nowPlaying
        /// Points above the bottom safe area (sign-in screens etc.).
        case bottom(CGFloat)

        /// Distance from the bottom safe-area edge to the stack's bottom.
        var clearance: CGFloat {
            switch self {
            case .shell(let mini): Shell.tabBar + (mini ? Shell.miniPlayerGap + Shell.miniPlayer + 8 : 16)
            case .nowPlaying: 112 // clears the now playing bottom row (device / lyrics / queue)
            case .bottom(let v): v
            }
        }
    }

    struct Toast: Identifiable, Equatable { let id = UUID(); var text: String }
    struct LyricSync: Equatable {
        var title: String
        var stage: String
        /// Further jobs waiting.
        var more: Int = 0
    }

    private(set) var toast: Toast?
    /// `Offline · downloaded music only` pill while offline.
    var offline = false
    /// The lyric-sync pill while jobs run.
    var lyricSync: LyricSync?
    var layout: Layout = .shell(miniPlayer: true)

    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var window: PassthroughWindow?

    /// Show `text` for 2.2 s (some messages use 5 s). A new toast replaces the old and restarts the timer.
    func show(_ text: String, seconds: Double = 2.2) {
        installIfNeeded()
        toast = Toast(text: text)
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    func hide() { timer?.cancel(); toast = nil }

    /// Attach the overlay window to the active scene (done lazily on first use too).
    func installIfNeeded() {
        guard window == nil,
              let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let w = PassthroughWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        w.backgroundColor = .clear
        let host = UIHostingController(rootView: ToastStack(center: self))
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false
        window = w
    }

    /// The overlay lives outside the app's view tree; give it the app's theme store once.
    var themeStore: ThemeStore?
    var theme: Theme { themeStore?.theme ?? .default }
}

/// The bottom-aligned stack: toast, lyric-sync pill, offline pill, 8 apart, all ignoring touches.
private struct ToastStack: View {
    let center: ToastCenter

    var body: some View {
        GeometryReader { g in
            VStack(spacing: 8) {
                Spacer()
                if let t = center.toast { ToastView(text: t.text).id(t.id) }
                if let s = center.lyricSync { LyricSyncPill(state: s).frame(maxWidth: min(560, g.size.width - 32)) }
                if center.offline { OfflinePill() }
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, center.layout.clearance)
            .frame(width: g.size.width, height: g.size.height)
        }
        .environment(\.theme, center.theme)
        .allowsHitTesting(false)
    }
}

/// A window that never takes touches, so toasts never block the app.
final class PassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }
}

/// `.toast`: `--accent` fill, `--on-accent` 14/500, padding 12/16, radius 8, shadow 0 4 12 .5.
/// No enter/exit animation.
struct ToastView: View {
    let text: String
    @Environment(\.theme) private var theme
    var body: some View {
        Text(text).textStyle(.toast).foregroundStyle(theme.onAccent)
            .multilineTextAlignment(.center)
            .padding(.vertical, 12).padding(.horizontal, 16)
            .background(theme.accent, in: RoundedRectangle(cornerRadius: Radius.dialog))
            .shadow(color: .black.opacity(0.5), radius: 6, y: 4)
            .padding(.horizontal, 16)
            .accessibilityAddTraits(.isStaticText)
    }
}

/// `Offline · downloaded music only`: #3a3a3a, white 12/600, padding 5/12, capsule, shadow 0 2 8 .4.
struct OfflinePill: View {
    var body: some View {
        Text(L("Offline · downloaded music only"))
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.white)
            .padding(.vertical, 5).padding(.horizontal, 12)
            .background(Theme.Fixed.offlinePill, in: Capsule())
            .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
    }
}

/// Lyric sync pill (LyricSyncStatus.jsx): `--bg-elevated-hi`, 13 pt, padding 10/16, capsule,
/// max `min(560, screen - 32)`; 14 pt spinner ring (white 20 %, accent top segment, 0.8 s),
/// then **Syncing lyrics** · {title} — {stage} [· {n} more].
struct LyricSyncPill: View {
    let state: ToastCenter.LyricSync
    @Environment(\.theme) private var theme
    @State private var spin = false

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().stroke(Color.white.opacity(0.2), lineWidth: 2)
                Circle().trim(from: 0, to: 0.25).stroke(theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .butt))
                    .rotationEffect(.degrees(spin ? 360 : 0))
            }
            .frame(width: 14, height: 14)
            .onAppear { withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) { spin = true } }
            Text(line).font(.system(size: 13)).foregroundStyle(theme.fg).lineLimit(1)
        }
        .padding(.vertical, 10).padding(.horizontal, 16)
        .background(theme.bgElevatedHi, in: Capsule())
    }

    private var line: AttributedString {
        var a = AttributedString(L("Syncing lyrics"))
        a.inlinePresentationIntent = .stronglyEmphasized
        var rest = " · \(state.title) — \(state.stage)"
        if state.more > 0 { rest += " · " + L("{n} more", ["n": state.more]) }
        return a + AttributedString(rest)
    }
}

#Preview("Toast and pills") {
    VStack(spacing: 8) {
        Spacer()
        ToastView(text: "Added to Liked Songs")
        LyricSyncPill(state: .init(title: "Paranoid Android", stage: "Aligning", more: 2))
        OfflinePill()
    }
    .padding(.bottom, 121)
    .frame(maxWidth: .infinity)
    .background(Theme.default.page)
}
