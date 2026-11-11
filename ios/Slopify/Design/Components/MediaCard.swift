import SwiftUI

/// Album / artist / playlist tile (UI.md 6.0.7). The whole card is one button: a tap always opens
/// the item (cards never play on phone). `round` = artist (circle art; centred text outside Home).
///
/// Styles: `.home` (Home and see-all: title 1 line 14/700 lh 1.3 +8, sub 13 `--fg-sub` 2 lines,
/// left aligned, art fades in) and `.page` (artist, genre, radar: title 2 lines lh 1.4 +4,
/// sub 13 `--fg-dim` 2 lines). `missing` greys the art and shows a request pill.
/// Card layout family (UI.md 6.0.7, 6.0.8).
enum CardStyle: Sendable { case home, page }

struct MediaCard<Art: View>: View {
    typealias Style = CardStyle

    var title: String
    var subtitle: String?
    var round = false
    var style: Style = .page
    /// Unavailable release: art `grayscale(.6) brightness(.55)`, title `--fg-dim`, `request` pill centred.
    var missing = false
    var request: RequestPill? = nil
    var action: () -> Void
    var onLongPress: (() -> Void)? = nil
    @ViewBuilder var art: () -> Art

    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            VStack(alignment: textAlign, spacing: 0) {
                art()
                    .aspectRatio(1, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: Radius.card)))
                    .grayscale(missing ? 0.6 : 0)
                    .colorMultiply(Color(white: missing ? 0.55 : 1))
                    .pressDim()
                    .overlay { if missing, let request { request } }
                Text(title)
                    .textStyle(style == .home ? .cardTitle : TextStyle(size: 14, weight: .bold, lineHeight: 1.4))
                    .foregroundStyle(missing ? theme.fgDim : theme.fg)
                    .lineLimit(style == .home ? 1 : 2)
                    .multilineTextAlignment(centred ? .center : .leading)
                    .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
                    .padding(.top, style == .home ? 8 : 4)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .textStyle(.cardSub)
                        .foregroundStyle(style == .home ? theme.fgSub : theme.fgDim)
                        .lineLimit(2)
                        .multilineTextAlignment(centred ? .center : .leading)
                        .frame(maxWidth: .infinity, alignment: centred ? .center : .leading)
                        .padding(.top, 2)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .buttonStyle(.pressPlain)
        .simultaneousGesture(LongPressGesture(minimumDuration: Gestures.longPressDuration, maximumDistance: Gestures.longPressSlop).onEnded { _ in
            guard let onLongPress else { return }
            Haptics.tick(); onLongPress()
        }, including: onLongPress == nil ? .subviews : .all)
    }

    private var centred: Bool { round && style == .page }
    private var textAlign: HorizontalAlignment { centred ? .center : .leading }
}

extension MediaCard where Art == CoverImage {
    /// Card with a server cover. Home cards fade in over the page; others sit on `#282828`.
    init(_ source: CoverSource, title: String, subtitle: String?, round: Bool = false, style: Style = .page,
         missing: Bool = false, request: RequestPill? = nil, artSize: CGFloat = 158, action: @escaping () -> Void, onLongPress: (() -> Void)? = nil) {
        self.title = title; self.subtitle = subtitle; self.round = round; self.style = style
        self.missing = missing; self.request = request; self.action = action; self.onLongPress = onLongPress
        let shape: CoverImage.Shape = round ? .circle : .rounded(Radius.card)
        let ph: CoverImage.Placeholder = style == .home ? .none : .cardHover
        self.art = { CoverImage(source, size: artSize, shape: shape, placeholder: ph, fade: style == .home) }
    }
}

/// Horizontal shelf (UI.md 6.0.8): fixed columns, gap 16, no snapping, no scroll bar.
/// `.home`: 150 pt columns, bleeds edge to edge with a 16 pt inset. `.page`: 158 pt columns,
/// clipped at the page's 16 pt inset, 6 pt bottom padding.
struct Shelf<Item: Identifiable, Cell: View>: View {
    var items: [Item]
    var style: CardStyle = .page
    @ViewBuilder var cell: (Item) -> Cell

    var column: CGFloat { style == .home ? 150 : 158 }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: Spacing.shelfGap) {
                ForEach(items) { cell($0).frame(width: column) }
            }
            .padding(.horizontal, style == .home ? Spacing.gutter : 0)
            .padding(.bottom, style == .home ? 0 : 6)
        }
        .scrollClipDisabled(style == .home)
        .padding(.horizontal, style == .home ? 0 : Spacing.gutter)
    }
}

/// Two-column grid in a padded page (UI.md 6.0.9): row gap 16, column gap 12.
struct CardGrid<Item: Identifiable, Cell: View>: View {
    var items: [Item]
    var columns = 2
    @ViewBuilder var cell: (Item) -> Cell

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: columns), spacing: 16) {
            ForEach(items) { cell($0) }
        }
        .padding(.horizontal, Spacing.gutter)
    }
}

/// Section heading (`.shelf-head`, UI.md 6.0.6): weight 700, size by page, optional "Show all"
/// (14/700 `--fg-dim`, hidden on Home by the web; pass nil there).
struct SectionHeader: View {
    enum Style: Sendable { case home, search, artist, detail }
    let title: String
    var style: Style = .detail
    /// First section on the page gets the smaller top margin.
    var first = false
    var showAll: (() -> Void)? = nil
    @Environment(\.theme) private var theme

    init(_ title: String, style: Style = .detail, first: Bool = false, showAll: (() -> Void)? = nil) {
        self.title = title; self.style = style; self.first = first; self.showAll = showAll
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).textStyle(textStyle).foregroundStyle(theme.fg).lineLimit(2)
            Spacer(minLength: 8)
            if let showAll {
                Button(L("Show all"), action: showAll)
                    .font(.system(size: 14, weight: .bold)).foregroundStyle(theme.fgDim)
                    .buttonStyle(.pressFade)
            }
        }
        .padding(.top, top)
        .padding(.bottom, 12)
        .padding(.horizontal, Spacing.gutter)
        .accessibilityAddTraits(.isHeader)
    }

    private var textStyle: TextStyle {
        switch style {
        case .home: .sectionHome
        case .search: .sectionSearch
        case .artist: .sectionArtist
        case .detail: .sectionDetail
        }
    }

    private var top: CGFloat {
        switch style {
        case .home: 0
        case .search: first ? 8 : 20
        case .artist: first ? 8 : 24
        case .detail: first ? 4 : 24
        }
    }
}

private struct PreviewItem: Identifiable { let id: Int }

#Preview("Cards, shelf, grid") {
    ScrollView {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader("Jump back in", style: .home)
            Shelf(items: (0..<5).map(PreviewItem.init), style: .home) { i in
                MediaCard(.url(nil), title: "Album \(i.id)", subtitle: "Artist", style: .home) {}
            }
            SectionHeader("Popular releases", style: .artist, showAll: {})
            Shelf(items: (0..<5).map(PreviewItem.init)) { i in
                MediaCard(.url(nil), title: "Release \(i.id) with a long name", subtitle: "2020 • Album",
                          missing: i.id == 1, request: RequestPill(title: L("Request")) {}) {}
            }
            SectionHeader("Fans also like", style: .detail)
            CardGrid(items: (0..<4).map(PreviewItem.init)) { i in
                MediaCard(.url(nil), title: "Artist \(i.id)", subtitle: L("Artist"), round: true) {}
            }
        }
    }
    .background(Theme.default.page)
}
