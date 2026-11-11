import Foundation

/// Pure colour maths ported from the web, so tests can check it against values the JS computed
/// (SlopifyTests/Design/ColorFixtures.json, made by ios/tools/color-fixtures.mjs).
/// Pixels are RGBA bytes, row-major, as a canvas `getImageData` returns them.
enum ColorMath {
    /// colors.js `rgbToHsl`: h, s, l in 0...1.
    static func rgbToHsl(_ r0: Double, _ g0: Double, _ b0: Double) -> (h: Double, s: Double, l: Double) {
        let r = r0 / 255, g = g0 / 255, b = b0 / 255
        let mx = max(r, g, b), mn = min(r, g, b), l = (mx + mn) / 2
        if mx == mn { return (0, 0, l) }
        let d = mx - mn
        let s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
        let h: Double
        if mx == r { h = (g - b) / d + (g < b ? 6 : 0) } else if mx == g { h = (b - r) / d + 2 } else { h = (r - g) / d + 4 }
        return (h / 6, s, l)
    }

    /// colors.js `hslToRgb`, rounded channels.
    static func hslToRgb(_ h: Double, _ s: Double, _ l: Double) -> [Int] {
        func f(_ n: Double) -> Int {
            let k = (n + h * 12).truncatingRemainder(dividingBy: 12)
            let a = s * min(l, 1 - l)
            return jsRound(255 * (l - a * max(-1, min(k - 3, 9 - k, 1))))
        }
        return [f(0), f(8), f(4)]
    }

    /// JS `Math.round` (halves go up).
    static func jsRound(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }

    private struct Bin { var n = 0.0, r = 0.0, g = 0.0, b = 0.0, h = 0.0, s = 0.0, l = 0.0 }
    private static func key(_ r: Int, _ g: Int, _ b: Int) -> Int { (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4) }

    /// colors.js `vibrantColor` on 40x40 pixels: the most prominent saturated mid-tone bin's mean.
    static func vibrant(_ px: [UInt8]) -> RGB? {
        var bins: [Bin] = [], index: [Int: Int] = [:]   // insertion order matters for ties
        var i = 0
        while i + 3 < px.count {
            let r = Int(px[i]), g = Int(px[i + 1]), b = Int(px[i + 2]); i += 4
            let (_, s, l) = rgbToHsl(Double(r), Double(g), Double(b))
            if l < 0.08 || l > 0.92 { continue }
            let k = key(r, g, b)
            let at: Int
            if let x = index[k] { at = x } else { at = bins.count; index[k] = at; bins.append(Bin()) }
            bins[at].n += 1; bins[at].r += Double(r); bins[at].g += Double(g); bins[at].b += Double(b)
            bins[at].s += s; bins[at].l += l
        }
        var best: Bin?, bestScore = -1.0
        for e in bins {
            let s = e.s / e.n, l = e.l / e.n
            let score = e.n * (0.15 + s) * (l > 0.2 && l < 0.75 ? 1 : 0.35)
            if score > bestScore { bestScore = score; best = e }
        }
        guard let e = best else { return nil }
        return RGB(Double(jsRound(e.r / e.n)), Double(jsRound(e.g / e.n)), Double(jsRound(e.b / e.n)))
    }

    /// colors.js `paletteColors` on 48x48 pixels: three gradient stops, light to dark.
    static func palette(_ px: [UInt8]) -> [RGB]? {
        var bins: [Bin] = [], index: [Int: Int] = [:]
        var total = 0, neutral = 0, i = 0
        while i + 3 < px.count {
            let r = Int(px[i]), g = Int(px[i + 1]), b = Int(px[i + 2]); i += 4
            let (h, s, l) = rgbToHsl(Double(r), Double(g), Double(b))
            total += 1
            if s < 0.15 || l < 0.08 || l > 0.92 { neutral += 1 }
            if l < 0.08 || l > 0.94 { continue }
            let k = key(r, g, b)
            let at: Int
            if let x = index[k] { at = x } else { at = bins.count; index[k] = at; bins.append(Bin()) }
            bins[at].n += 1; bins[at].r += Double(r); bins[at].g += Double(g); bins[at].b += Double(b)
            bins[at].h += h; bins[at].s += s; bins[at].l += l
        }
        if total > 0 && Double(neutral) / Double(total) >= 0.6 { return [RGB(hex: 0xffffff), RGB(hex: 0xe2e2e2), RGB(hex: 0xbebebe)] }
        struct E { var rgb: [Int]; var h, s, l, score: Double }
        let ranked = bins.enumerated().map { idx, e -> (Int, E) in
            let l = e.l / e.n
            return (idx, E(rgb: [jsRound(e.r / e.n), jsRound(e.g / e.n), jsRound(e.b / e.n)], h: e.h / e.n, s: e.s / e.n, l: l,
                           score: e.n * (0.15 + e.s / e.n) * (l > 0.2 && l < 0.8 ? 1 : 0.35)))
        }.sorted { $0.1.score != $1.1.score ? $0.1.score > $1.1.score : $0.0 < $1.0 }.map(\.1)
        func hueDist(_ a: Double, _ b: Double) -> Double { let x = abs(a - b); return min(x, 1 - x) }
        var out: [E] = []
        for e in ranked {
            if out.count >= 3 { break }
            if out.allSatisfy({ hueDist($0.h, e.h) > 0.08 || abs($0.l - e.l) > 0.3 }) && e.s > 0.12 { out.append(e) }
        }
        guard let first = out.first else { return nil }
        func shift(_ e: E, _ dl: Double) -> E {
            let l = max(0.15, min(0.85, e.l + dl))
            return E(rgb: hslToRgb(e.h, max(e.s, 0.35), l), h: e.h, s: e.s, l: l, score: 0)
        }
        while out.count < 3 { out.append(shift(first, out.count == 1 ? 0.22 : -0.22)) }
        out = out.enumerated().sorted { $0.1.l != $1.1.l ? $0.1.l > $1.1.l : $0.0 < $1.0 }.map(\.1)
        let floor = [0.66, 0.54, 0.42]
        return out.enumerated().map { i, e in
            let c = hslToRgb(e.h, min(0.62, max(e.s, 0.38)), max(e.l, floor[i]))
            return RGB(Double(c[0]), Double(c[1]), Double(c[2]))
        }
    }

    /// Player.jsx `clampLightness`: lightness into [lo, hi], hue and saturation kept.
    /// Mini player card colour: `clampLightness(vibrant)`.
    static func clampLightness(_ c: RGB, lo: Double = 0.18, hi: Double = 0.30) -> RGB {
        let r = c.r / 255, g = c.g / 255, b = c.b / 255
        let mx = max(r, g, b), mn = min(r, g, b)
        var h = 0.0
        let l = (mx + mn) / 2, d = mx - mn
        let sat = d == 0 ? 0 : d / (1 - abs(2 * l - 1))
        if d != 0 {
            if mx == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) } else if mx == g { h = (b - r) / d + 2 } else { h = (r - g) / d + 4 }
            h = (h * 60 + 360).truncatingRemainder(dividingBy: 360)
        }
        let nl = min(hi, max(lo, l))
        if nl == l { return c }
        let cc = (1 - abs(2 * nl - 1)) * sat
        let x = cc * (1 - abs((h / 60).truncatingRemainder(dividingBy: 2) - 1)), m = nl - cc / 2
        let (r2, g2, b2): (Double, Double, Double) =
            h < 60 ? (cc, x, 0) : h < 120 ? (x, cc, 0) : h < 180 ? (0, cc, x) : h < 240 ? (0, x, cc) : h < 300 ? (x, 0, cc) : (cc, 0, x)
        return RGB(Double(jsRound((r2 + m) * 255)), Double(jsRound((g2 + m) * 255)), Double(jsRound((b2 + m) * 255)))
    }

    /// Library.jsx `heroTint(rgb, phone: true)` as the browser paints it:
    /// `color-mix(in srgb, hsl(H S% L%) 55%, #121212)` with S clamped to 30...65% and L to 24...38%.
    static func heroTint(_ c: RGB) -> RGB {
        let r = c.r / 255, g = c.g / 255, b = c.b / 255
        let mx = max(r, g, b), mn = min(r, g, b), l = (mx + mn) / 2
        var h = 0.0, sat = 0.0
        if mx != mn {
            let d = mx - mn
            sat = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
            h = mx == r ? ((g - b) / d + (g < b ? 6 : 0)) : mx == g ? (b - r) / d + 2 : (r - g) / d + 4
            h /= 6
        }
        sat = min(0.65, sat > 0.04 ? max(sat, 0.3) : sat)
        let L = min(0.38, max(0.24, l))
        let H = Double(jsRound(h * 360)), S = Double(jsRound(sat * 100)), Lp = Double(jsRound(L * 100))
        let base = cssHsl(H, S, Lp)
        return base.colorMix(0.55, RGB(hex: 0x121212))
    }

    /// Library.jsx `phoneHero(hex)`: fixed palette colours through the same clamp. Nil for a bad hex.
    static func phoneHero(_ hex: String) -> RGB? { RGB.strictHex(hex).map(heroTint) }

    /// CSS Color 4 `hsl(h s% l%)` to sRGB 0...255 (unrounded).
    static func cssHsl(_ h: Double, _ s: Double, _ l: Double) -> RGB {
        let s = s / 100, l = l / 100
        func f(_ n: Double) -> Double {
            let k = (n + h / 30).truncatingRemainder(dividingBy: 12), a = s * min(l, 1 - l)
            return (l - a * max(-1, min(k - 3, 9 - k, 1))) * 255
        }
        return RGB(f(0), f(8), f(4))
    }

    /// Library.jsx `blurhashAverage`: the DC term of a blurhash (instant hero tint before sampling).
    static func blurhashAverage(_ hash: String?) -> RGB? {
        guard let hash, hash.count >= 6 else { return nil }
        let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~")
        var v = 0
        for ch in hash.dropFirst(2).prefix(4) {
            guard let i = alphabet.firstIndex(of: ch) else { return nil }
            v = v * 83 + i
        }
        return RGB(Double(v >> 16 & 255), Double(v >> 8 & 255), Double(v & 255))
    }

    /// Detail page `--hero` precedence (UI.md 6.3.1 step 5), given what is known.
    static func detailHero(mixColor: String? = nil, sampled: RGB? = nil, isArtist: Bool = false, isLiked: Bool = false) -> RGB {
        if let m = mixColor, let c = phoneHero(m) { return c }
        if !isArtist, let s = sampled { return heroTint(s) }
        if isLiked { return heroTint(Theme.Fixed.likedHero) }
        if isArtist, let s = sampled { return heroTint(s) }
        return Theme.Fixed.defaultHero
    }
}
