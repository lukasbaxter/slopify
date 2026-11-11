import SwiftUI

/// Filter pill (UI.md 6.0.5): min height 32, padding 0/16, fully round, 14/500 (13 in the
/// Library tab: `small`). Off: `--chip` / `--fg`; on: `--accent` / `--on-accent`. Rows space them 8.
struct Chip: View {
    let title: String
    var on = false
    var small = false
    var action: () -> Void
    @Environment(\.theme) private var theme

    init(_ title: String, on: Bool = false, small: Bool = false, action: @escaping () -> Void) {
        self.title = title; self.on = on; self.small = small; self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title).textStyle(small ? .chipSmall : .chip).lineLimit(1)
                .foregroundStyle(on ? theme.onAccent : theme.fg)
                .padding(.horizontal, 16).frame(minHeight: 32)
                .background(on ? theme.accent : theme.chip, in: Capsule())
        }
        .buttonStyle(.pressFade)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A horizontally scrolling row of chips, 8 apart, inset by the page gutter.
struct ChipRow<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) { content() }.padding(.horizontal, Spacing.gutter)
        }
    }
}

#Preview {
    ChipRow { Chip("All", on: true) {}; Chip("Music") {}; Chip("Playlists", small: true) {} }
        .padding(.vertical).background(Theme.default.page)
}
