import SwiftUI

/// `SearchRow` (Library.jsx:86-103, mobile-home-search.css:145-154): 48 pt art (round for
/// artists), name 16 / lh 1.3, sub 13 `--fg-sub`, min height 64, padding 8 0, gap 12; optional
/// trailing action and the 44 pt remove button (recent searches).
struct SearchRow<Action: View>: View {
    var source: CoverSource
    var round = false
    var name: String
    var sub: String
    /// Everywhere release the library lacks: art `grayscale(.4) brightness(.7)`, name `--fg-sub`.
    var missing = false
    var onTap: () -> Void
    var onRemove: (() -> Void)? = nil
    @ViewBuilder var action: () -> Action
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 12) {
            CoverImage(source, size: 48, shape: round ? .circle : .rounded(Radius.art), placeholder: .chip)
                .frame(width: 48, height: 48)
                .grayscale(missing ? 0.4 : 0)
                .colorMultiply(Color(white: missing ? 0.7 : 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).textStyle(TextStyle(size: 16, weight: .regular, lineHeight: 1.3))
                    .foregroundStyle(missing ? theme.fgSub : theme.fg).lineLimit(1)
                if !sub.isEmpty {
                    Text(sub).textStyle(TextStyle(size: 13, weight: .regular, lineHeight: 1.3))
                        .foregroundStyle(theme.fgSub).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action()
            if let onRemove {
                Button(action: onRemove) {
                    IconView(.close, size: 16).foregroundStyle(theme.fgSub).frame(width: 44, height: 44)
                }
                .buttonStyle(.pressFade)
                .padding(.trailing, -12)
                .accessibilityLabel(L("Remove"))
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isButton)
    }
}

extension SearchRow where Action == EmptyView {
    init(source: CoverSource, round: Bool = false, name: String, sub: String, missing: Bool = false,
         onTap: @escaping () -> Void, onRemove: (() -> Void)? = nil) {
        self.init(source: source, round: round, name: name, sub: sub, missing: missing, onTap: onTap, onRemove: onRemove) { EmptyView() }
    }
}

/// Browse tile (`.tile`, app.css:947-951, mobile-home-search.css:139-143): 100 pt high, radius 4,
/// padding 12, the tile colour; 15/700 title top-left at 58 % width; a 56 % cover rotated 25°
/// peeking out bottom-right (-18 %), shadow `0 8 24 rgba(0,0,0,.5)`. Press: brightness .8.
struct SearchBrowseTile<Cover: View>: View {
    var title: String
    var color: RGB
    var action: () -> Void
    @ViewBuilder var cover: () -> Cover
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            GeometryReader { g in
                let w = g.size.width, h = g.size.height, side = w * 0.56
                ZStack(alignment: .topLeading) {
                    color.color
                    cover()
                        .frame(width: side, height: side)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.art))
                        .shadow(color: .black.opacity(0.5), radius: 12, y: 8)
                        .rotationEffect(.degrees(25))
                        .position(x: w + w * 0.18 - side / 2, y: h + h * 0.18 - side / 2)
                    Text(title)
                        .textStyle(TextStyle(size: 15, weight: .bold, tracking: -0.3, lineHeight: 1.2))
                        .foregroundStyle(theme.darkIsland.fg)
                        .frame(maxWidth: w * 0.58, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(12)
                }
            }
            .frame(height: 100)
            .clipShape(RoundedRectangle(cornerRadius: Radius.art))
            .pressDim()
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressPlain)
        .darkIsland()
        .accessibilityLabel(title)
    }
}
