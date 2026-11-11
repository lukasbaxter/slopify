import SwiftUI

/// How a glyph element is painted. `.current` = the view's foreground style (SVG currentColor).
enum IconPaint: Hashable, Sendable {
    case current
    /// `var(--seek-accent)` (filled heart).
    case seekAccent
    /// `var(--green)` (download progress ring).
    case green
    case rgb(UInt32)
}

/// One SVG element (path or circle), with the style it inherits from its `<svg>` / `<g>`.
struct IconElement: Sendable {
    var d: String
    var fill: IconPaint?
    var stroke: IconPaint? = nil
    var lineWidth: CGFloat = 1
    var cap: CGLineCap = .butt
    var join: CGLineJoin = .miter
    var evenOdd = false
    var opacity: Double = 1
    var strokeOpacity: Double = 1
    /// SVG `rotate(deg cx cy)`.
    var rotate: (Double, Double, Double)? = nil

    /// The parsed path in viewBox units (parsed once, then cached).
    var path: CGPath { SVGPath.cached(d) }
}

/// A glyph: a square viewBox (16, 20 or 24) and its elements, drawn in order.
struct IconSpec: Sendable {
    var viewBox: CGFloat
    var elements: [IconElement]
}

/// Minimal SVG path-data parser (M L H V C S Q T A Z, absolute and relative), enough for every
/// path in web/src. Arcs are converted to cubic Béziers.
enum SVGPath {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: CGPath] = [:]

    static func cached(_ d: String) -> CGPath {
        if let p = lock.withLock({ cache[d] }) { return p }
        let p = parse(d)
        lock.withLock { cache[d] = p }
        return p
    }

    static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        var tokens = Tokenizer(Array(d.utf8))
        var cmd: UInt8 = 0
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint? = nil, lastQuad: CGPoint? = nil
        while let next = tokens.peekCommand() ?? (cmd != 0 && tokens.hasNumber ? cmd : nil) {
            if tokens.peekCommand() != nil { tokens.skipCommand() }
            cmd = next
            let rel = cmd >= 97 // lowercase
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
            var ctrl: CGPoint? = nil, quad: CGPoint? = nil
            switch cmd | 0x20 { // lowercase
            case UInt8(ascii: "m"):
                guard let x = tokens.number(), let y = tokens.number() else { return path }
                cur = pt(x, y); start = cur; path.move(to: cur)
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L") // following pairs are lineto
            case UInt8(ascii: "l"):
                guard let x = tokens.number(), let y = tokens.number() else { return path }
                cur = pt(x, y); path.addLine(to: cur)
            case UInt8(ascii: "h"):
                guard let x = tokens.number() else { return path }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur)
            case UInt8(ascii: "v"):
                guard let y = tokens.number() else { return path }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur)
            case UInt8(ascii: "c"):
                guard let x1 = tokens.number(), let y1 = tokens.number(), let x2 = tokens.number(), let y2 = tokens.number(),
                      let x = tokens.number(), let y = tokens.number() else { return path }
                let c1 = pt(x1, y1), c2 = pt(x2, y2), e = pt(x, y)
                path.addCurve(to: e, control1: c1, control2: c2); cur = e; ctrl = c2
            case UInt8(ascii: "s"):
                guard let x2 = tokens.number(), let y2 = tokens.number(), let x = tokens.number(), let y = tokens.number() else { return path }
                let c1 = lastCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = pt(x2, y2), e = pt(x, y)
                path.addCurve(to: e, control1: c1, control2: c2); cur = e; ctrl = c2
            case UInt8(ascii: "q"):
                guard let x1 = tokens.number(), let y1 = tokens.number(), let x = tokens.number(), let y = tokens.number() else { return path }
                let c = pt(x1, y1), e = pt(x, y)
                path.addQuadCurve(to: e, control: c); cur = e; quad = c
            case UInt8(ascii: "t"):
                guard let x = tokens.number(), let y = tokens.number() else { return path }
                let c = lastQuad.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let e = pt(x, y)
                path.addQuadCurve(to: e, control: c); cur = e; quad = c
            case UInt8(ascii: "a"):
                guard let rx = tokens.number(), let ry = tokens.number(), let rot = tokens.number(),
                      let large = tokens.flag(), let sweep = tokens.flag(), let x = tokens.number(), let y = tokens.number() else { return path }
                let e = pt(x, y)
                addArc(path, from: cur, to: e, rx: rx, ry: ry, angle: rot, large: large, sweep: sweep)
                cur = e
            case UInt8(ascii: "z"):
                path.closeSubpath(); cur = start; cmd = 0 // a number after Z is invalid; stop repeating
            default:
                return path
            }
            lastCtrl = ctrl; lastQuad = quad
        }
        return path
    }

    /// SVG endpoint arc (F.6.5 of the SVG spec) as cubic segments.
    private static func addArc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, angle: CGFloat, large: Bool, sweep: Bool) {
        if p0 == p1 { return }
        var rx = abs(rx0), ry = abs(ry0)
        if rx == 0 || ry == 0 { path.addLine(to: p1); return }
        let phi = angle * .pi / 180, cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { let s = sqrt(lambda); rx *= s; ry *= s }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx
        let cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2
        let cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2
        func ang(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && dt > 0 { dt -= 2 * .pi } else if sweep && dt < 0 { dt += 2 * .pi }
        let segs = Int(ceil(abs(dt) / (.pi / 2)))
        let step = dt / CGFloat(segs)
        let k = 4.0 / 3.0 * tan(step / 4)
        var t = t1
        func point(_ a: CGFloat) -> CGPoint {
            let x = rx * cos(a), y = ry * sin(a)
            return CGPoint(x: cosP * x - sinP * y + cx, y: sinP * x + cosP * y + cy)
        }
        func deriv(_ a: CGFloat) -> CGPoint {
            let x = -rx * sin(a), y = ry * cos(a)
            return CGPoint(x: cosP * x - sinP * y, y: sinP * x + cosP * y)
        }
        for i in 0..<segs {
            let a = t, b = t + step
            let pa = point(a), pb = i == segs - 1 ? p1 : point(b)
            let da = deriv(a), db = deriv(b)
            path.addCurve(to: pb, control1: CGPoint(x: pa.x + k * da.x, y: pa.y + k * da.y), control2: CGPoint(x: pb.x - k * db.x, y: pb.y - k * db.y))
            t = b
        }
    }

    private struct Tokenizer {
        let s: [UInt8]
        var i = 0
        init(_ s: [UInt8]) { self.s = s }

        mutating func skipSeparators() {
            while i < s.count, s[i] == 32 || s[i] == 44 || s[i] == 9 || s[i] == 10 || s[i] == 13 { i += 1 }
        }
        mutating func peekCommand() -> UInt8? {
            skipSeparators()
            guard i < s.count else { return nil }
            let c = s[i]
            return (c >= 65 && c <= 90 || c >= 97 && c <= 122) && c != UInt8(ascii: "e") && c != UInt8(ascii: "E") ? c : nil
        }
        mutating func skipCommand() { i += 1 }
        var hasNumber: Bool {
            mutating get {
                skipSeparators()
                guard i < s.count else { return false }
                let c = s[i]
                return c == 45 || c == 43 || c == 46 || (c >= 48 && c <= 57)
            }
        }
        /// SVG number grammar: sign, digits, one dot, exponent. "1.5.5" is 1.5 then .5.
        mutating func number() -> CGFloat? {
            skipSeparators()
            let st = i
            if i < s.count, s[i] == 45 || s[i] == 43 { i += 1 }
            var dot = false, digits = false
            while i < s.count {
                let c = s[i]
                if c >= 48 && c <= 57 { digits = true; i += 1 } else if c == 46 && !dot { dot = true; i += 1 } else { break }
            }
            if digits, i < s.count, s[i] == 101 || s[i] == 69 {
                var j = i + 1
                if j < s.count, s[j] == 45 || s[j] == 43 { j += 1 }
                if j < s.count, s[j] >= 48 && s[j] <= 57 {
                    i = j
                    while i < s.count, s[i] >= 48 && s[i] <= 57 { i += 1 }
                }
            }
            guard digits, let str = String(bytes: s[st..<i], encoding: .ascii), let v = Double(str) else { i = st; return nil }
            return CGFloat(v)
        }
        /// Arc flags may be packed without separators ("a1 1 0 011 1").
        mutating func flag() -> Bool? {
            skipSeparators()
            guard i < s.count, s[i] == 48 || s[i] == 49 else { return nil }
            defer { i += 1 }
            return s[i] == 49
        }
    }
}
