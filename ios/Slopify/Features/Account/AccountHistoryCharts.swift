import SwiftUI

/// "Daily" / "Cumulative" line chart (History.jsx `LineChart`, UI.md 7.5.5 #5). Drawn in real
/// points with 11 pt labels (DECISIONS: readable labels); touch and drag scrubs (DECISIONS fix).
struct AccountHistoryLineChart: View {
    let title: String
    let points: [AccountHistoryLogic.Point]

    @Environment(\.theme) private var theme
    @State private var hover: Int?

    private let padL: CGFloat = 44, padR: CGFloat = 12, padT: CGFloat = 12, padB: CGFloat = 24

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.horizontal, 4).padding(.bottom, 4)
            GeometryReader { g in
                let size = g.size
                chart(size)
                    .contentShape(Rectangle())
                    .simultaneousGesture(DragGesture(minimumDistance: 0)
                        .onChanged { v in
                            hover = AccountHistoryLogic.scrubIndex(x: v.location.x, plotMinX: padL, plotMaxX: size.width - padR, count: points.count)
                        }
                        .onEnded { _ in hover = nil })
                    .overlay(alignment: .topLeading) { tooltip(size) }
            }
            .frame(height: 170)
            legend.padding(.top, 8)
        }
        .padding(.top, 12).padding(.horizontal, 12).padding(.bottom, 8)
        .background(theme.card, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(summary)
    }

    private var summary: String {
        guard let last = points.last else { return "" }
        let loc = Localizer.shared.locale
        return "\(last.label): \(AccountHistoryLogic.streams(Int(last.streams), locale: loc))"
    }

    private func geometry(_ size: CGSize) -> (x: (Int) -> CGFloat, y: (Double) -> CGFloat, ticks: [Double]) {
        let n = points.count
        let maxV = max(1, points.map { max($0.streams, $0.minutes) }.max() ?? 1)
        let ticks = AccountHistoryLogic.ticks(max: maxV)
        let top = ticks.last ?? 1
        let w = size.width - padL - padR, h = size.height - padT - padB
        let x: (Int) -> CGFloat = { i in padL + (n > 1 ? CGFloat(i) / CGFloat(n - 1) * w : w / 2) }
        let y: (Double) -> CGFloat = { v in padT + (1 - CGFloat(v / top)) * h }
        return (x, y, ticks)
    }

    private func chart(_ size: CGSize) -> some View {
        let n = points.count
        let (x, y, ticks) = geometry(size)
        let locale = Localizer.shared.locale
        let theme = theme, hover = hover, points = points
        let labelIdx = Set(AccountHistoryLogic.xLabelIndices(n))
        return Canvas { ctx, sz in
            for v in ticks {
                var p = Path(); p.move(to: CGPoint(x: padL, y: y(v))); p.addLine(to: CGPoint(x: sz.width - padR, y: y(v)))
                ctx.stroke(p, with: .color(theme.fg(0.06)), lineWidth: 1)
                ctx.draw(Text(AccountHistoryLogic.number(v, locale: locale)).font(.system(size: 11)).foregroundColor(theme.fgFaint),
                         at: CGPoint(x: padL - 8, y: y(v)), anchor: .trailing)
            }
            for i in labelIdx.sorted() {
                let anchor: UnitPoint = i == 0 ? .leading : i == n - 1 ? .trailing : .center
                ctx.draw(Text(points[i].label).font(.system(size: 11)).foregroundColor(theme.fgFaint),
                         at: CGPoint(x: x(i), y: sz.height - 8), anchor: anchor)
            }
            func line(_ key: KeyPath<AccountHistoryLogic.Point, Double>) -> Path {
                var p = Path()
                for (i, pt) in points.enumerated() {
                    let q = CGPoint(x: x(i), y: y(pt[keyPath: key]))
                    if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
                }
                return p
            }
            let style = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
            if n > 0 {
                ctx.stroke(line(\.minutes), with: .color(theme.green.opacity(0.45)), style: style)
                ctx.stroke(line(\.streams), with: .color(theme.green), style: style)
            }
            if let i = hover, points.indices.contains(i) {
                var c = Path(); c.move(to: CGPoint(x: x(i), y: padT)); c.addLine(to: CGPoint(x: x(i), y: sz.height - padB))
                ctx.stroke(c, with: .color(theme.fg(0.35)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                let s = CGPoint(x: x(i), y: y(points[i].streams)), m = CGPoint(x: x(i), y: y(points[i].minutes))
                ctx.fill(Path(ellipseIn: CGRect(x: m.x - 4, y: m.y - 4, width: 8, height: 8)), with: .color(theme.green.opacity(0.45)))
                ctx.fill(Path(ellipseIn: CGRect(x: s.x - 4, y: s.y - 4, width: 8, height: 8)), with: .color(theme.green))
            }
        }
    }

    @ViewBuilder
    private func tooltip(_ size: CGSize) -> some View {
        if let i = hover, points.indices.contains(i) {
            let p = points[i]
            let loc = Localizer.shared.locale
            let s = Int(p.streams), m = Int(p.minutes)
            let box = VStack(alignment: .leading, spacing: 2) {
                Text(p.label).bold()
                Text(s == 1 ? L("1 stream") : L("{n} streams", ["n": AccountHistoryLogic.number(s, locale: loc)]))
                Text(m == 1 ? L("1 minute streamed") : L("{n} minutes streamed", ["n": AccountHistoryLogic.number(m, locale: loc)]))
            }
            .font(.system(size: 12)).foregroundStyle(theme.fg)
            .padding(.vertical, 6).padding(.horizontal, 10)
            .background(theme.page, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.fg(0.08), lineWidth: 1))
            .fixedSize()
            let x = geometry(size).x(i)
            // Centred on the point, kept inside the card.
            box.alignmentGuide(.leading) { d in
                let left = min(max(0, x - d.width / 2), max(0, size.width - d.width))
                return -left
            }
            .offset(y: 28)
            .allowsHitTesting(false)
        }
    }

    private var legend: some View {
        HStack(spacing: 16) {
            HStack(spacing: 6) { Circle().fill(theme.green).frame(width: 8, height: 8); Text(L("streams")) }
            HStack(spacing: 6) { Circle().fill(theme.green.opacity(0.45)).frame(width: 8, height: 8); Text(L("minutes streamed")) }
        }
        .font(.system(size: 12)).foregroundStyle(theme.fgSub)
        .frame(maxWidth: .infinity)
    }
}

/// Listening clock (History.jsx `Clock`): 24 equal wedges from 12 o'clock clockwise, radius by
/// value, spokes, hour labels 0/6/12/18. Drawn in a 320 box scaled to the width (max 360).
/// Tapping a wedge shows its hour and value (the web's native SVG tooltip).
struct AccountHistoryClock: View {
    let values: [Double]
    let format: (Double) -> String

    @Environment(\.theme) private var theme
    @State private var picked: Int?

    var body: some View {
        let theme = theme, values = values, picked = picked
        let fr = AccountHistoryLogic.clockFractions(values)
        VStack(spacing: 4) {
            Canvas { ctx, sz in
                let s = min(sz.width, sz.height) / 320
                let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
                let R = 150 * s
                func pt(_ a: Double, _ r: CGFloat) -> CGPoint { CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a)) }
                for i in 0..<fr.count {
                    var p = Path(); p.move(to: c); p.addLine(to: pt(-Double.pi / 2 + Double(i) * Double.pi / 12, R))
                    ctx.stroke(p, with: .color(theme.fg(0.12)), lineWidth: 1)
                }
                for (i, f) in fr.enumerated() where f > 0 {
                    let a0 = -Double.pi / 2 + Double(i) * Double.pi / 12
                    var w = Path()
                    w.move(to: c)
                    w.addArc(center: c, radius: R * f, startAngle: .radians(a0), endAngle: .radians(a0 + Double.pi / 12), clockwise: false)
                    w.closeSubpath()
                    ctx.fill(w, with: .color(theme.green.opacity(picked == nil || picked == i ? 1 : 0.5)))
                    ctx.stroke(w, with: .color(theme.page), lineWidth: 2)
                }
                for (h, x, y) in [(0, 160.0, 14.0), (6, 310.0, 164.0), (12, 160.0, 314.0), (18, 10.0, 164.0)] {
                    let p = CGPoint(x: c.x + (x - 160) * s, y: c.y + (y - 4 - 160) * s)
                    ctx.draw(Text("\(h)").font(.system(size: 12)).foregroundColor(theme.fgFaint), at: p, anchor: .center)
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .frame(maxWidth: 360)
            .contentShape(Rectangle())
            .overlay { GeometryReader { g in Color.clear.contentShape(Rectangle()).onTapGesture { loc in pick(loc, size: g.size) } } }
            Text(picked.map { "\(AccountHistoryLogic.hourLabel($0)): \(format(values.indices.contains($0) ? values[$0] : 0))" } ?? " ")
                .font(.system(size: 12)).foregroundStyle(theme.fgSub)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(values.enumerated().filter { $0.element > 0 }.map { "\(AccountHistoryLogic.hourLabel($0.offset)): \(format($0.element))" }.joined(separator: ", "))
    }

    private func pick(_ loc: CGPoint, size: CGSize) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let dx = loc.x - c.x, dy = loc.y - c.y
        let r = (dx * dx + dy * dy).squareRoot()
        guard r <= 150 * min(size.width, size.height) / 320 else { picked = nil; return }
        // Angle from 12 o'clock, clockwise.
        var a = atan2(Double(dy), Double(dx)) + Double.pi / 2
        if a < 0 { a += 2 * Double.pi }
        let i = Int(a / (Double.pi / 12)) % 24
        picked = picked == i ? nil : i
    }
}
