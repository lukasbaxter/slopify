import SwiftUI

/// One line that ping-pongs when it overflows (Marquee.jsx, app.css:666-683; UI.md 3.6).
/// `dist = textWidth - boxWidth`; when > 0 the text moves to `-(dist + 24)` over
/// `D = 4 + dist/30` s per direction, holding 25 % at each end, linear, alternating.
/// Right edge fades over 28 pt always; the left 20 pt fade shows only while moving.
/// Static and clipped when it fits. Style the text with the usual modifiers on `Marquee`.
struct Marquee: View {
    let text: String
    @State private var box: CGFloat = 0
    @State private var width: CGFloat = 0

    init(_ text: String) { self.text = text }

    var body: some View {
        let dist = max(0, width - box)
        Text(text).lineLimit(1).fixedSize().hidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                GeometryReader { g in
                    Color.clear.onAppear { box = g.size.width }.onChange(of: g.size.width) { _, w in box = w }
                }
            }
            .overlay(alignment: .leading) {
                if dist > 0 {
                    TimelineView(.animation) { ctx in
                        let (x, moving) = Self.offset(at: ctx.date.timeIntervalSinceReferenceDate, dist: dist)
                        Text(text).lineLimit(1).fixedSize().offset(x: x)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .mask(Self.mask(leftFade: moving))
                    }
                } else {
                    Text(text).lineLimit(1).fixedSize().frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .clipped()
            .background(alignment: .leading) {
                Text(text).lineLimit(1).fixedSize().hidden()
                    .background(GeometryReader { g in
                        Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { _, w in width = w }
                    })
            }
            .accessibilityLabel(text)
    }

    /// Position and whether the left fade is on, `t` seconds into the loop. Public for tests.
    static func offset(at t: TimeInterval, dist: CGFloat) -> (CGFloat, Bool) {
        let d = 4 + Double(dist) / 30
        let cycle = (t.truncatingRemainder(dividingBy: 2 * d) + 2 * d).truncatingRemainder(dividingBy: 2 * d)
        let forward = cycle < d
        let p = forward ? cycle / d : 1 - (cycle - d) / d   // alternate
        let move = min(1, max(0, (p - 0.25) / 0.5))
        let x = -CGFloat(move) * (dist + 24)
        // mask keyframes: left fade slides in between 25 % and 28 % of each direction
        return (x, p > 0.25)
    }

    private static func mask(leftFade: Bool) -> some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [leftFade ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing).frame(width: 20)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 28)
        }
    }
}

/// Entity title ladder 96 -> 72 -> 48 -> 32 at weight 800 until it fits `maxLines`
/// (FittedTitle.jsx). The phone forces a fixed 24 pt on detail heroes (UI.md 6.3.2), so use this
/// only where the web's phone CSS does not override it.
struct FittedTitle: View {
    let text: String
    var maxLines = 2
    static let ladder: [CGFloat] = [96, 72, 48, 32]

    var body: some View {
        ViewThatFits(in: .vertical) {
            ForEach(Self.ladder, id: \.self) { size in
                Text(text).font(.system(size: size, weight: .heavy)).lineLimit(maxLines)
                    .lineSpacing(size * 0.05).fixedSize(horizontal: false, vertical: true)
            }
            Text(text).font(.system(size: 32, weight: .heavy)).lineLimit(maxLines)
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 16) {
        Marquee("A very long song title that does not fit in this narrow box at all").frame(width: 200)
        Marquee("Short").frame(width: 200)
        FittedTitle(text: "OK Computer")
    }
    .foregroundStyle(.white).padding().background(Theme.default.page)
}
