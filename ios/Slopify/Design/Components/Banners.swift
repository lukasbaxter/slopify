import SwiftUI

/// `.banner.error` (UI.md 2.9, 6.0.10): padding 12/16, radius 8, `--danger-bg`, `--danger` 14 pt.
/// Page placement adds margin 16 24 (`.pageBanner()`); the player error bar uses `compact`
/// (padding 8/16, radius 4). Tap runs `onTap` (dismiss).
struct ErrorBanner: View {
    let message: String
    var compact = false
    var onTap: (() -> Void)? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        Text(message).font(.system(size: 14)).foregroundStyle(theme.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, compact ? 8 : 12).padding(.horizontal, 16)
            .background(theme.dangerBg, in: RoundedRectangle(cornerRadius: compact ? 4 : Radius.dialog))
            .contentShape(Rectangle())
            .onTapGesture { onTap?() }
            .accessibilityHint(onTap == nil ? "" : L("Dismiss"))
    }

    /// Top-of-page placement: margin 16 vertical, 24 horizontal.
    func pageBanner() -> some View { padding(.vertical, 16).padding(.horizontal, 24) }
}

/// `.placeholder-note`: 13 pt `--fg-sub`, padding 16, margin 8 0.
struct PlaceholderNote: View {
    let text: String
    @Environment(\.theme) private var theme
    var body: some View {
        Text(text).font(.system(size: 13)).foregroundStyle(theme.fgSub)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16).padding(.vertical, 8)
    }
}

#Preview {
    VStack {
        ErrorBanner(message: "Not saved: network error").pageBanner()
        ErrorBanner(message: "Playback failed", compact: true)
        PlaceholderNote(text: "Nothing here yet")
    }
    .background(Theme.default.page)
}
