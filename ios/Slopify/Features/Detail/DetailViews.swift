import SwiftUI
import UIKit

// Small views only the detail pages use. Candidates for Design/ are marked TODO(lead).

/// The page error banner under the top bar (`.banner.error`), tap to dismiss.
struct DetailErrorBanner: View {
    @Binding var error: String?

    var body: some View {
        if let e = error {
            // The overlay sits inside the safe area: clear the 56 pt top bar (pageBanner adds 16).
            ErrorBanner(message: e) { error = nil }
                .pageBanner()
                .padding(.top, Shell.topBar - 16)
        }
    }
}

// TODO(lead): candidate shared component: the outlined pill used by "See more" / "Show less"
// (`.seemore`) and "See discography" (`.seedisco`): min height 32, padding 0 16, 13/700,
// 1 pt `--fg-faint` border, fully round. Same look as FollowPill without the state.
struct DetailOutlinePill: View {
    let title: String
    var action: () -> Void
    @Environment(\.theme) private var theme

    init(_ title: String, action: @escaping () -> Void) { self.title = title; self.action = action }

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.horizontal, 16).frame(minHeight: 32)
                .overlay(Capsule().strokeBorder(theme.fgFaint, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
    }
}

/// `.shelf-head` on the artist page with the right-hand hint (`.settings-hint`, 13 pt `--fg-dim`).
/// TODO(lead): SectionHeader could take a hint string instead.
struct DetailSectionHeader: View {
    let title: String
    var hint: String?
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).textStyle(.sectionArtist).foregroundStyle(theme.fg).lineLimit(2)
            Spacer(minLength: 8)
            if let hint { Text(hint).font(.system(size: 13)).foregroundStyle(theme.fgDim).lineLimit(1) }
        }
        .padding(.top, 24).padding(.bottom, 12)
        .padding(.horizontal, Spacing.gutter)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A photo drawn aspect-fill with its focal point at (`x`, `y`) of the box, like CSS
/// `background-position: center 25%` (the artist banner).
struct DetailFocalImage: View {
    let url: URL?
    var x: CGFloat = 0.5
    var y: CGFloat = 0.25
    @State private var image: UIImage?

    var body: some View {
        GeometryReader { g in
            if let image {
                let iw = image.size.width, ih = image.size.height
                let s = max(g.size.width / max(iw, 1), g.size.height / max(ih, 1))
                let w = iw * s, h = ih * s
                Image(uiImage: image).resizable()
                    .frame(width: w, height: h)
                    .offset(x: (g.size.width - w) * x, y: (g.size.height - h) * y)
                    .transition(.opacity)
            }
        }
        .clipped()
        .task(id: url) {
            guard let url else { image = nil; return }
            if let c = ImageLoader.shared.cached(url) { image = c; return }
            let img = await ImageLoader.shared.image(url)
            withAnimation(Motion.imageFade) { image = img }
        }
        .accessibilityHidden(true)
    }
}

extension View {
    /// Re-read the playlists whenever the library changes (another page, another device).
    func detailOnLibraryChanged(_ action: @escaping @MainActor () async -> Void) -> some View {
        task {
            for await _ in NotificationCenter.default.notifications(named: .libraryChanged) { await action() }
        }
    }
}
