import SwiftUI
import UIKit

/// The home screen icon (owner, 11-11): the lock is the app's own icon; the rest are alternate
/// icons in Assets.xcassets (`AppIcon-<id>`, previews `IconPreview-<id>`), switched with
/// `setAlternateIconName`. iOS shows its own "You have changed the icon" alert; apps can't hide it.
enum AccountAppIcon {
    struct Choice: Identifiable, Equatable {
        /// nil = the primary icon (the lock).
        let id: String?
        let name: String
        var preview: String { "IconPreview-" + (id.map { String($0.dropFirst("AppIcon-".count)) } ?? "Default") }
        var label: String { L(name) }
    }

    static let all: [Choice] = [Choice(id: nil, name: "Slopify")] + [
        ("Classic", "Classic"), ("ClassicOnWhite", "Classic on white"), ("GreenTile", "Green tile"),
        ("BlackAndWhite", "Black & white"), ("MidnightGreen", "Midnight green"), ("NeonRing", "Neon ring"),
        ("TrafficLight", "Traffic light"), ("RGBWaves", "RGB waves"), ("Rainbow", "Rainbow"),
        ("Sunset", "Sunset"), ("Ocean", "Ocean"), ("Grape", "Grape"),
        ("Fire", "Fire"), ("Aurora", "Aurora"), ("Chrome", "Chrome"), ("Gold", "Gold"),
        ("Pink", "Pink"), ("SunsetTile", "Sunset tile"), ("OceanTile", "Ocean tile"), ("GrapeTile", "Grape tile"),
        ("Retro", "Retro"), ("Pastel", "Pastel"), ("Ghost", "Ghost"), ("NeonRGBRing", "Neon RGB ring"),
    ].map { Choice(id: "AppIcon-\($0.0)", name: $0.1) }

    /// The choice matching iOS's current alternate icon name (unknown names read as the default).
    static func choice(for alternate: String?) -> Choice {
        all.first { $0.id == alternate } ?? all[0]
    }

    @MainActor static var current: Choice { choice(for: UIApplication.shared.alternateIconName) }

    @MainActor static func set(_ c: Choice) async throws {
        guard UIApplication.shared.supportsAlternateIcons, UIApplication.shared.alternateIconName != c.id else { return }
        try await UIApplication.shared.setAlternateIconName(c.id)
    }
}

/// Settings › App icon: a grid of every icon, the current one ringed.
struct AccountAppIconPicker: View {
    @Environment(\.theme) private var theme
    @State private var current = AccountAppIcon.current

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 12), count: 4)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L("App icon"))
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(theme.fg)
            // No ScrollView here: the bottom sheet sizes to its content and scrolls by itself when
            // that is too tall; a ScrollView inside measured as nothing (11-11: the sheet was empty).
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(AccountAppIcon.all) { c in cell(c) }
            }
            .padding(.vertical, 4)
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
    }

    private func cell(_ c: AccountAppIcon.Choice) -> some View {
        let on = c == current
        return Button {
            Task {
                do { try await AccountAppIcon.set(c); current = AccountAppIcon.current }
                catch { ToastCenter.shared.show(L("Could not change the icon: {error}", ["error": error.localizedDescription])) }
            }
        } label: {
            VStack(spacing: 6) {
                Image(c.preview)
                    .resizable()
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .padding(3)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(on ? theme.accent : .clear, lineWidth: 2.5))
                Text(c.label)
                    .font(.system(size: 11, weight: on ? .bold : .regular))
                    .foregroundStyle(on ? theme.fg : theme.fgSub)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .buttonStyle(.pressFade)
        .accessibilityLabel(c.label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
