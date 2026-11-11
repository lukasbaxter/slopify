import SwiftUI

/// Shortcut tile (UI.md 6.1.4): 56 tall, `--chip`, radius 4, 56 pt art flush left, 13/700 two-line
/// label (lh 1.25, padding 10 / 8). Press: `rgba(fg,.08)` and art brightness .8. Opens, never plays.
struct HomeShortcutTile: View {
    let shortcut: HomeLogic.Shortcut
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) { Face(shortcut: shortcut) }
            .buttonStyle(.pressPlain)
            .accessibilityLabel(title)
    }

    private var title: String {
        switch shortcut {
        case .liked: L("Liked Songs")
        case .album(let a): HomeLogic.tileTitle(a.name)
        case .playlist(let p): HomeLogic.tileTitle(p.name)
        }
    }

    private struct Face: View {
        let shortcut: HomeLogic.Shortcut
        @Environment(\.theme) private var theme
        @Environment(\.isPressed) private var pressed

        var body: some View {
            HStack(spacing: 0) {
                art.frame(width: 56, height: 56).pressDim()
                Text(label)
                    .textStyle(TextStyle(size: 13, weight: .bold, lineHeight: 1.25))
                    .foregroundStyle(theme.fg)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.leading, 10).padding(.trailing, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: 56)
            .background(theme.chip)
            .overlay { if pressed { theme.fg(0.08) } }
            .clipShape(RoundedRectangle(cornerRadius: Radius.art))
            .contentShape(RoundedRectangle(cornerRadius: Radius.art))
        }

        private var label: String {
            switch shortcut {
            case .liked: L("Liked Songs")
            case .album(let a): HomeLogic.tileTitle(a.name)
            case .playlist(let p): HomeLogic.tileTitle(p.name)
            }
        }

        @ViewBuilder private var art: some View {
            switch shortcut {
            case .liked: LikedCover(heart: 0.45, radius: 0)
            case .album(let a): CoverImage(.init(a), size: 56, shape: .rounded(0), placeholder: .none)
            case .playlist(let p): CoverImage(.init(p), size: 56, shape: .rounded(0), placeholder: .none)
            }
        }
    }
}

/// Daily Mix / Top Songs composite art (UI.md 6.1.6, 6.3.6): photo kept by its top edge over a
/// `160deg mix(color 55% black) -> color` ground, with a band in the raw mix colour carrying the label.
struct HomeMixArt: View {
    var source: CoverSource?
    var color: RGB
    var label: String
    /// Home tile: 14 pt, padding 6/10, bottom radius 2. Page cover: 16 pt, padding 10/14, no radius.
    var large = false
    var pixelSize: CGFloat

    @Environment(\.apiClient) private var api
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var shown = false

    var body: some View {
        let u = source?.url(api, size: Int((pixelSize * max(scale, 1)).rounded(.up)))
        ZStack(alignment: .bottom) {
            LinearGradient(colors: [color.colorMix(0.55, .black).color, color.color],
                           startPoint: UnitPoint(x: 0.33, y: 0.03), endPoint: UnitPoint(x: 0.67, y: 0.97))
            GeometryReader { g in
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: g.size.width, height: g.size.height, alignment: .top)
                        .clipped()
                        .opacity(shown ? 1 : 0)
                }
            }
            Text(label)
                .font(.system(size: large ? 16 : 14, weight: .bold))
                .tracking(-0.2)
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .padding(.vertical, large ? 10 : 6).padding(.horizontal, large ? 14 : 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(color.color)
                .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: large ? 0 : Radius.card, bottomTrailingRadius: large ? 0 : Radius.card))
        }
        .task(id: u) {
            guard let u else { image = nil; shown = false; return }
            if let hit = ImageLoader.shared.cached(u) { image = hit; shown = true; return }
            guard let img = await ImageLoader.shared.image(u), !Task.isCancelled else { return }
            image = img
            withAnimation(Motion.imageFade) { shown = true }
        }
        .accessibilityHidden(true)
    }
}

/// The hero's mix mark (`.hero-avatar.mixmark`): a 20 pt disc in the raw mix colour with a white note.
struct HomeMixMark: View {
    var color: RGB
    var body: some View {
        Circle().fill(color.color)
            .overlay { IconView(.musicNote, size: 12).foregroundStyle(Color.white) }
    }
}
