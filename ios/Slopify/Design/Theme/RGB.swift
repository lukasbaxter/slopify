import SwiftUI

/// An sRGB colour with 0...255 channels (Double so blends stay exact until they are rounded,
/// as the web's `mix()` and CSS `color-mix()` do). `alpha` is 0...1.
struct RGB: Hashable, Sendable, CustomStringConvertible {
    var r: Double
    var g: Double
    var b: Double
    var alpha: Double = 1

    init(_ r: Double, _ g: Double, _ b: Double, alpha: Double = 1) {
        self.r = r; self.g = g; self.b = b; self.alpha = alpha
    }

    /// `0xRRGGBB`.
    init(hex: UInt32, alpha: Double = 1) {
        self.init(Double(hex >> 16 & 255), Double(hex >> 8 & 255), Double(hex & 255), alpha: alpha)
    }

    /// `#rrggbb`, `#rgb` or `#rrggbbaa` (case-insensitive, `#` optional). Nil for anything else.
    init?(hex s: String) {
        var h = s.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        guard h.allSatisfy(\.isHexDigit) else { return nil }
        if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
        guard h.count == 6 || h.count == 8, let n = UInt32(h.prefix(6), radix: 16) else { return nil }
        let a = h.count == 8 ? Double(UInt32(h.suffix(2), radix: 16) ?? 255) / 255 : 1
        self.init(hex: n, alpha: a)
    }

    /// Strict 6-digit form, the only one the web's `hexToRgb` accepts for themes.
    static func strictHex(_ s: String?) -> RGB? {
        guard let s, s.range(of: "^#?[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return nil }
        return RGB(hex: s)
    }

    /// Channels rounded and clamped the way the web's `clamp()` does.
    var rounded: RGB { RGB(Self.clamp(r), Self.clamp(g), Self.clamp(b), alpha: alpha) }
    var ints: [Int] { [Int(Self.clamp(r)), Int(Self.clamp(g)), Int(Self.clamp(b))] }

    /// Lowercase `#rrggbb`.
    var hex: String { ints.map { String(format: "%02x", $0) }.joined().prefixed("#") }
    var description: String { alpha < 1 ? "\(hex)@\(alpha)" : hex }

    var color: Color { Color(.sRGB, red: r / 255, green: g / 255, blue: b / 255, opacity: alpha) }
    var uiColor: UIColor { UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: alpha) }

    func opacity(_ a: Double) -> RGB { RGB(r, g, b, alpha: a) }

    /// Web `mix(a, b, t)`: per-channel linear blend towards `other` by `t`, rounded.
    func mix(_ other: RGB, _ t: Double) -> RGB {
        RGB(r + (other.r - r) * t, g + (other.g - g) * t, b + (other.b - b) * t).rounded
    }

    /// CSS `color-mix(in srgb, self p, other)`: `p` of self, the rest of `other`, rounded.
    func colorMix(_ p: Double, _ other: RGB) -> RGB {
        RGB(r * p + other.r * (1 - p), g * p + other.g * (1 - p), b * p + other.b * (1 - p)).rounded
    }

    /// Web `isLight`: YIQ brightness over 140.
    var isLight: Bool { (r * 299 + g * 587 + b * 114) / 1000 > 140 }

    /// WCAG relative luminance (prefs.js `luminance`).
    var luminance: Double {
        func lin(_ v: Double) -> Double { let v = v / 255; return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    func contrast(_ other: RGB) -> Double {
        let a = luminance, b = other.luminance
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    /// prefs.js `inkOn`: black or white, whichever reads on this colour (black wins ties).
    var inkOn: RGB { contrast(.black) >= contrast(.white) ? .black : .white }

    static let black = RGB(hex: 0x000000)
    static let white = RGB(hex: 0xffffff)

    private static func clamp(_ x: Double) -> Double { max(0, min(255, x.rounded(.toNearestOrAwayFromZero))) }
}

private extension String {
    func prefixed(_ p: String) -> String { p + self }
}
