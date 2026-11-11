import SwiftUI

/// Artwork tile: album, track, playlist, artist (round), folder, or any URL.
/// Placeholder square while loading or when there is no picture, cross-fade in (150 ms ease-out,
/// Home FadeImg), aspect-fill, clipped to `shape`. No layout of its own: give it a frame.
///
///     CoverImage(.init(album), size: 48).frame(width: 48, height: 48)
///     CoverImage(.init(artist), size: 150, shape: .circle)
struct CoverImage: View {
    enum Shape: Hashable { case rounded(CGFloat), circle }
    enum Placeholder: Hashable {
        /// `--chip` square (sheets, skeletons, default).
        case chip
        /// `--card-hover` (#282828): track rows, cards, mini player.
        case cardHover
        /// Music-note glyph on `--chip` (cards without art, `mobile-library.css:196`).
        case note
        /// Nothing behind the image (Home cards show the page until decoded).
        case none
    }

    let source: CoverSource
    /// Wanted size in points; the request asks for points x screen scale.
    var size: CGFloat
    var shape: Shape = .rounded(Radius.art)
    var placeholder: Placeholder = .chip
    var fade = true
    /// Called with the loaded image (e.g. to sample its colour).
    var onLoad: ((UIImage) -> Void)? = nil

    @Environment(\.apiClient) private var api
    @Environment(\.theme) private var theme
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var shown = false

    init(_ source: CoverSource, size: CGFloat, shape: Shape = .rounded(Radius.art), placeholder: Placeholder = .chip, fade: Bool = true, onLoad: ((UIImage) -> Void)? = nil) {
        self.source = source; self.size = size; self.shape = shape; self.placeholder = placeholder; self.fade = fade; self.onLoad = onLoad
    }

    private var url: URL? { source.url(api, size: Int((size * max(scale, 1)).rounded(.up))) }

    var body: some View {
        let u = url
        ZStack {
            placeholderView
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
                    .opacity(shown ? 1 : 0)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        .clipShape(clip)
        .contentShape(clip)
        .task(id: u) { await load(u) }
        .accessibilityHidden(true)
    }

    private var clip: AnyShape {
        switch shape {
        case .circle: AnyShape(Circle())
        case .rounded(let r): AnyShape(RoundedRectangle(cornerRadius: r, style: .continuous))
        }
    }

    @ViewBuilder private var placeholderView: some View {
        switch placeholder {
        case .chip: theme.chip
        case .cardHover: theme.cardHover
        case .none: Color.clear
        case .note:
            theme.chip.overlay {
                GeometryReader { g in
                    IconView(.musicNote, size: min(g.size.width, g.size.height) * 0.32)
                        .foregroundStyle(theme.fgFaint)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
    }

    private func load(_ u: URL?) async {
        guard let u else { image = nil; shown = false; return }
        if let hit = ImageLoader.shared.cached(u) {
            image = hit; shown = true; onLoad?(hit); return
        }
        if image != nil { shown = false }
        guard let img = await ImageLoader.shared.image(u), !Task.isCancelled else { return }
        image = img
        onLoad?(img)
        if fade { withAnimation(Motion.imageFade) { shown = true } } else { shown = true }
    }
}

/// Liked Songs tile: 135deg #450af5 -> #c4efd9 with a centred white heart at `heart` of the box.
struct LikedCover: View {
    var heart: CGFloat = 0.45
    var radius: CGFloat = Radius.art

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            LinearGradient(colors: Theme.Fixed.likedGradient, startPoint: .topLeading, endPoint: .bottomTrailing)
                .overlay { IconView(.heartFilled, size: side * heart, tint: .white, tintAll: true) }
        }
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .accessibilityHidden(true)
    }
}

#Preview("Covers") {
    HStack(spacing: 12) {
        CoverImage(.url(nil), size: 64).frame(width: 64, height: 64)
        CoverImage(.url(nil), size: 64, shape: .circle).frame(width: 64, height: 64)
        CoverImage(.url(nil), size: 64, placeholder: .note).frame(width: 64, height: 64)
        LikedCover().frame(width: 64, height: 64)
    }
    .padding().background(Theme.default.page)
}
