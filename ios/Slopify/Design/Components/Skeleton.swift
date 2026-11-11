import SwiftUI

/// Loading rows (UI.md 2.9, 6.0.11): min height 64, optional 48x48 art (playlists and mixes),
/// bars 55 % x 12 and 35 % x 10, radius 6, `--chip`, gap 8; pulse 1 -> .45 -> 1 over 1.4 s.
struct SkeletonRows: View {
    var count = 8
    var art = false
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { _ in
                HStack(spacing: 12) {
                    if art { RoundedRectangle(cornerRadius: Radius.art).fill(theme.chip).frame(width: 48, height: 48) }
                    GeometryReader { g in
                        VStack(alignment: .leading, spacing: 8) {
                            RoundedRectangle(cornerRadius: 6).fill(theme.chip).frame(width: g.size.width * 0.55, height: 12)
                            RoundedRectangle(cornerRadius: 6).fill(theme.chip).frame(width: g.size.width * 0.35, height: 10)
                        }
                        .frame(maxHeight: .infinity)
                    }
                }
                .padding(.vertical, 8).padding(.horizontal, Spacing.gutter)
                .frame(height: Shell.trackRow)
            }
        }
        .skeletonPulse()
        .accessibilityHidden(true)
    }
}

/// Title placeholder (`.sk-title`): 60 % x 22, radius 6, margin 12 0 8.
struct SkeletonTitle: View {
    @Environment(\.theme) private var theme
    var body: some View {
        GeometryReader { g in
            RoundedRectangle(cornerRadius: 6).fill(theme.chip).frame(width: g.size.width * 0.6, height: 22)
        }
        .frame(height: 22)
        .padding(.top, 12).padding(.bottom, 8)
        .skeletonPulse()
        .accessibilityHidden(true)
    }
}

extension View {
    /// Opacity 1 -> .45 -> 1, 1.4 s ease-in-out, forever.
    func skeletonPulse() -> some View { modifier(Pulse()) }
}

private struct Pulse: ViewModifier {
    @State private var dim = false
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.45 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true } }
    }
}

#Preview {
    VStack(alignment: .leading) { SkeletonTitle().padding(.horizontal, 16); SkeletonRows(count: 4, art: true) }
        .background(Theme.default.page)
}
