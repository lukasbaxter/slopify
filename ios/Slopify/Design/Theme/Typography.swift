import SwiftUI

/// The type scale (UI.md 2.2). System font only. A style carries size, weight, tracking
/// (CSS letter-spacing in pt) and an optional line height; apply with `.textStyle(_:)`.
struct TextStyle: Hashable, Sendable {
    var size: CGFloat
    var weight: Font.Weight
    var tracking: CGFloat = 0
    /// CSS line-height as a multiple of the size (nil = system default).
    var lineHeight: CGFloat? = nil

    var font: Font { .system(size: size, weight: weight) }
    var uiFont: UIFont { .systemFont(ofSize: size, weight: weight.uiWeight) }

    // Encore scale (app.css:97-104)
    static let titleLg = TextStyle(size: 48, weight: .bold, tracking: -2)
    static let titleMd = TextStyle(size: 32, weight: .bold, tracking: -1)
    static let titleSm = TextStyle(size: 24, weight: .bold)
    static let body = TextStyle(size: 16, weight: .regular)
    static let bodyBold = TextStyle(size: 16, weight: .bold)
    static let small = TextStyle(size: 14, weight: .regular)
    static let smallBold = TextStyle(size: 14, weight: .bold)
    static let marginal = TextStyle(size: 12, weight: .regular)

    // Phone roles
    /// Root page titles ("Search", "Your Library"), detail hero title: 24/700, -0.3.
    static let pageTitle = TextStyle(size: 24, weight: .bold, tracking: -0.3, lineHeight: 1.2)
    /// Track-row title, sheet rows: 16/400.
    static let rowTitle = TextStyle(size: 16, weight: .regular)
    /// Sub-lines under titles: 13/400 (colour `fgSub`).
    static let subLine = TextStyle(size: 13, weight: .regular)
    /// Card title: 14/700, line-height 1.3 (Home) / 1.4 (elsewhere).
    static let cardTitle = TextStyle(size: 14, weight: .bold, lineHeight: 1.3)
    static let cardSub = TextStyle(size: 13, weight: .regular, lineHeight: 1.3)
    /// Tab bar label: 10/500.
    static let tabLabel = TextStyle(size: 10, weight: .medium)
    /// Detail top bar title, sheet header title: 16/700.
    static let barTitle = TextStyle(size: 16, weight: .bold)
    /// Section headings (UI.md 6.0.6).
    static let sectionHome = TextStyle(size: 24, weight: .bold, tracking: -0.3, lineHeight: 1.2)
    static let sectionSearch = TextStyle(size: 18, weight: .bold, tracking: -0.2)
    static let sectionArtist = TextStyle(size: 20, weight: .bold)
    static let sectionDetail = TextStyle(size: 24, weight: .bold, tracking: -0.3)
    /// Chips: 14/500 (Library chips 13/500).
    static let chip = TextStyle(size: 14, weight: .medium)
    static let chipSmall = TextStyle(size: 13, weight: .medium)
    /// Buttons: 14/700.
    static let button = TextStyle(size: 14, weight: .bold)
    /// Toast: 14/500.
    static let toast = TextStyle(size: 14, weight: .medium)
    /// Mini player title 13/600 and artist 13/400, line-height 1.25.
    static let miniTitle = TextStyle(size: 13, weight: .semibold, lineHeight: 1.25)
    static let miniArtist = TextStyle(size: 13, weight: .regular, lineHeight: 1.25)
    /// Quality badge: 12/500, line-height 14, letter-spacing .02em.
    static let qualityBadge = TextStyle(size: 12, weight: .medium, tracking: 0.24)
    /// Dialog title: 20/700.
    static let dialogTitle = TextStyle(size: 20, weight: .bold)
    /// Menu heading-only item: 12/700.
    static let menuHeading = TextStyle(size: 12, weight: .bold)
    /// Monospace for hex values (Settings colour inputs).
    static let mono = TextStyle(size: 14, weight: .regular)
}

extension Font.Weight {
    var uiWeight: UIFont.Weight {
        switch self {
        case .ultraLight: .ultraLight
        case .thin: .thin
        case .light: .light
        case .medium: .medium
        case .semibold: .semibold
        case .bold: .bold
        case .heavy: .heavy
        case .black: .black
        default: .regular
        }
    }
}

extension View {
    /// Font, tracking and line spacing of a `TextStyle`.
    func textStyle(_ s: TextStyle) -> some View {
        let extra = s.lineHeight.map { max(0, $0 * s.size - s.uiFont.lineHeight) } ?? 0
        return self.font(s.font).tracking(s.tracking).lineSpacing(extra)
    }
}

extension Font {
    /// Monospaced system font for colour hex inputs.
    static func mono(_ size: CGFloat = 14) -> Font { .system(size: size, design: .monospaced) }
}
