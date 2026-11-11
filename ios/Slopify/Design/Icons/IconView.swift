import SwiftUI

extension Icon {
    /// The filled ("on") partner of an outline glyph: tab glyphs and the heart.
    var filled: Icon {
        switch self {
        case .homeTab: .homeTabFilled
        case .searchTab: .searchTabFilled
        case .libraryTab: .libraryTabFilled
        case .heart: .heartFilled
        default: self
        }
    }
}

/// Draws a web glyph at `size` points, painted with the foreground style (SVG currentColor),
/// except parts the web paints with a fixed colour (the heart's `--seek-accent`, black arrows).
///
///     IconView(.heart, filled: liked, size: 24).foregroundStyle(theme.fgSub)
///     IconView(.homeTab, filled: isOn, size: 24)
struct IconView: View {
    let icon: Icon
    var size: CGFloat
    /// Overrides the foreground style for `.current` parts.
    var tint: Color?
    /// Paint every part with `tint`, including fixed-colour parts (the Liked Songs tile's white heart).
    var tintAll = false

    @Environment(\.theme) private var theme

    init(_ icon: Icon, filled: Bool = false, size: CGFloat = 16, tint: Color? = nil, tintAll: Bool = false) {
        self.icon = filled ? icon.filled : icon
        self.size = size
        self.tint = tint
        self.tintAll = tintAll
    }

    var body: some View {
        let spec = icon.spec
        let theme = theme, tint = tint, all = tintAll
        Canvas { ctx, sz in
            IconView.draw(spec, in: &ctx, size: sz, theme: theme, tint: tint, tintAll: all)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    static func draw(_ spec: IconSpec, in ctx: inout GraphicsContext, size: CGSize, theme: Theme, tint: Color?, tintAll: Bool = false) {
        let scale = min(size.width, size.height) / spec.viewBox
        let dx = (size.width - spec.viewBox * scale) / 2, dy = (size.height - spec.viewBox * scale) / 2
        for el in spec.elements {
            var t = CGAffineTransform(translationX: dx, y: dy).scaledBy(x: scale, y: scale)
            if let (deg, cx, cy) = el.rotate {
                t = t.translatedBy(x: cx, y: cy).rotated(by: deg * .pi / 180).translatedBy(x: -cx, y: -cy)
            }
            let path = Path(el.path).applying(t)
            func shading(_ p: IconPaint) -> GraphicsContext.Shading {
                if tintAll, let tint { return .color(tint) }
                switch p {
                case .current: return tint.map { GraphicsContext.Shading.color($0) } ?? .foreground
                case .seekAccent: return .color(theme.seekAccent)
                case .green: return .color(theme.green)
                case .rgb(let x): return .color(RGB(hex: x).color)
                }
            }
            var c = ctx
            c.opacity = el.opacity
            if let f = el.fill { c.fill(path, with: shading(f), style: FillStyle(eoFill: el.evenOdd)) }
            if let s = el.stroke {
                var sc = c
                sc.opacity = el.opacity * el.strokeOpacity
                sc.stroke(path, with: shading(s), style: StrokeStyle(lineWidth: el.lineWidth * scale, lineCap: el.cap, lineJoin: el.join))
            }
        }
    }
}

/// Repeat button glyph. Repeat-one adds the "1" badge (DECISIONS: fix, do not copy).
struct RepeatGlyph: View {
    enum Mode: String, Sendable { case off, all, one }
    var mode: Mode
    var size: CGFloat = 18

    var body: some View {
        IconView(.repeat, size: size)
            .overlay(alignment: .topTrailing) {
                if mode == .one {
                    Text(verbatim: "1")
                        .font(.system(size: max(7, size * 0.42), weight: .bold))
                        .monospacedDigit()
                        .padding(.horizontal, size * 0.06)
                        .background(Circle().fill(.background).frame(width: size * 0.5, height: size * 0.5))
                        .offset(x: size * 0.18, y: -size * 0.2)
                }
            }
    }
}

/// Shuffle button glyph. Smart shuffle adds the spark (the desktop footer's mark, Player.jsx:333).
struct ShuffleGlyph: View {
    enum Mode: String, Sendable { case off, on, smart }
    var mode: Mode
    var size: CGFloat = 18

    var body: some View {
        IconView(.shuffle, size: size)
            .overlay(alignment: .topTrailing) {
                if mode == .smart {
                    IconView(.spark, size: size * 0.5).offset(x: size * 0.25, y: -size * 0.22)
                }
            }
    }
}

/// The detail-page download button glyph (Library.jsx:2007-2026), drawn at `size` (24 on phone).
struct DownloadGlyph: View {
    enum State: Hashable, Sendable { case none, busy(progress: Double), part, done }
    var state: State
    var size: CGFloat = 24

    @Environment(\.theme) private var theme

    var body: some View {
        Canvas { ctx, sz in
            let s = min(sz.width, sz.height) / 24
            ctx.scaleBy(x: s, y: s)
            func line(_ d: String, _ color: GraphicsContext.Shading, _ w: CGFloat) {
                ctx.stroke(Path(SVGPath.cached(d)), with: color, style: StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round))
            }
            switch state {
            case .part, .done:
                ctx.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: 24, height: 24)), with: .foreground)
                line("M12 6v9m0 0-3.5-3.5M12 15l3.5-3.5M7.5 18h9", .color(.black), 1.8)
            case .none, .busy:
                let ring = Path(ellipseIn: CGRect(x: 1.5, y: 1.5, width: 21, height: 21))
                var faint = ctx
                if case .busy = state { faint.opacity = 0.3 }
                faint.stroke(ring, with: .foreground, lineWidth: 1.5)
                if case .busy(let p) = state {
                    let c = 2 * Double.pi * 10.5
                    let arc = Path { $0.addArc(center: CGPoint(x: 12, y: 12), radius: 10.5, startAngle: .degrees(-90), endAngle: .degrees(270), clockwise: false) }
                    ctx.stroke(arc, with: .color(theme.green), style: StrokeStyle(lineWidth: 1.5, dash: [c * max(0.03, p), c]))
                }
                line("M12 7v8m0 0-3-3m3 3 3-3", .foreground, 1.5)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview("All icons") {
    ScrollView {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(64)), count: 5), spacing: 12) {
            ForEach(Icon.allCases, id: \.self) { i in
                VStack(spacing: 4) {
                    IconView(i, size: 24)
                    Text(i.rawValue).font(.system(size: 8)).lineLimit(1)
                }
            }
            RepeatGlyph(mode: .one, size: 24)
            ShuffleGlyph(mode: .smart, size: 24)
            DownloadGlyph(state: .busy(progress: 0.4))
            DownloadGlyph(state: .done).foregroundStyle(Theme.default.seekAccent)
        }
        .padding()
    }
    .foregroundStyle(.white)
    .background(Theme.default.page)
}
