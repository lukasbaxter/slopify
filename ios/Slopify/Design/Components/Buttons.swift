import SwiftUI

/// White pill (dialog "Create", Save): `--fg` fill, `--on-fg` 14/700 text, padding 10/24,
/// 40 % when disabled (UI.md 2.10).
struct PrimaryButton: View {
    let title: String
    var action: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }

    var body: some View {
        Button(action: action) {
            Text(title).textStyle(.button).foregroundStyle(theme.onFg)
                .padding(.vertical, 10).padding(.horizontal, 24)
                .background(theme.fg, in: Capsule())
        }
        .buttonStyle(.pressFade)
        .opacity(enabled ? 1 : 0.4)
    }
}

/// Outlined pill (dialog "Cancel"): 1 pt #7a7a7a border, 14/700, padding 8/16, min height 32.
struct SecondaryButton: View {
    let title: String
    var action: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }

    var body: some View {
        Button(action: action) {
            Text(title).textStyle(.button).foregroundStyle(theme.fg)
                .padding(.vertical, 8).padding(.horizontal, 16)
                .frame(minHeight: 32)
                .overlay(Capsule().strokeBorder(Theme.Fixed.secondaryButtonBorder, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
        .opacity(enabled ? 1 : 0.4)
    }
}

/// The green round play button of detail pages (`.bigplay`, UI.md 6.3.3): 48 circle `--accent`,
/// 22 pt glyph `--on-accent`, pressed `--accent-press`. Pause glyph while `playing`.
struct BigPlayButton: View {
    var playing: Bool
    var size: CGFloat = 48
    var glyph: CGFloat = 22
    var action: () -> Void

    var body: some View {
        Button(action: action) { EmptyView() }
            .buttonStyle(BigPlayStyle(playing: playing, size: size, glyph: glyph))
            .accessibilityLabel(playing ? L("Pause") : L("Play"))
    }

    private struct BigPlayStyle: ButtonStyle {
        let playing: Bool, size: CGFloat, glyph: CGFloat
        @Environment(\.theme) private var theme
        func makeBody(configuration: Configuration) -> some View {
            Circle().fill(configuration.isPressed ? theme.accentPress : theme.accent)
                .frame(width: size, height: size)
                .overlay { IconView(playing ? .pause : .play, size: glyph).foregroundStyle(theme.onAccent) }
                .contentShape(Circle())
        }
    }
}

/// Action-row icon button (`.iconbtn`): 40x40 hit box, 24 pt glyph `--fg-sub`; `on` paints the
/// glyph `--seek-accent` (shuffle on, album saved, download held). Press: opacity .6.
struct IconButton<Glyph: View>: View {
    var on = false
    var size: CGFloat = 40
    var label: String
    var action: () -> Void
    @ViewBuilder var glyph: () -> Glyph
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            glyph().foregroundStyle(on ? theme.seekAccent : theme.fgSub).frame(width: size, height: size)
        }
        .buttonStyle(.pressFade)
        .accessibilityLabel(label)
    }
}

extension IconButton where Glyph == IconView {
    init(_ icon: Icon, on: Bool = false, glyphSize: CGFloat = 24, size: CGFloat = 40, label: String, action: @escaping () -> Void) {
        self.on = on; self.size = size; self.label = label; self.action = action
        self.glyph = { IconView(icon, size: glyphSize) }
    }
}

/// Artist "Follow" / "Following" outlined pill (UI.md 6.3.3): min height 32, padding 0/16,
/// 13/700, 1 pt border `--fg-faint`, white border while following.
struct FollowPill: View {
    var following: Bool
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            Text(following ? L("Following") : L("Follow"))
                .font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.horizontal, 16).frame(minHeight: 32)
                .overlay(Capsule().strokeBorder(following ? theme.fg : theme.fgFaint, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
    }
}

/// Request pill over a missing release card (UI.md 6.0.7): white, black 12/700, padding 6/12;
/// busy: `--tint-press` with white text.
struct RequestPill: View {
    var title: String
    var busy = false
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .bold))
                .foregroundStyle(busy ? Color.white : Color.black)
                .padding(.vertical, 6).padding(.horizontal, 12)
                .background(busy ? RGB(hex: 0xffffff, alpha: 0x36 / 255).color : Color.white, in: Capsule())
                .shadow(color: .black.opacity(0.4), radius: 8, y: 8)
        }
        .buttonStyle(.pressFade)
        .disabled(busy)
    }
}

#Preview("Buttons") {
    VStack(spacing: 16) {
        HStack { SecondaryButton(L("Cancel")) {}; PrimaryButton(L("Create")) {} }
        HStack(spacing: 4) {
            IconButton(.heart, label: "Like") {}
            IconButton(.heartFilled, on: true, label: "Liked") {}
            IconButton(label: "Shuffle", action: {}) { ShuffleGlyph(mode: .smart, size: 24) }
            Spacer()
            BigPlayButton(playing: false) {}
        }
        HStack { FollowPill(following: false) {}; FollowPill(following: true) {} }
        RequestPill(title: L("Request")) {}
    }
    .padding().background(Theme.default.page)
}
