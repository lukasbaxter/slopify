import SwiftUI
import UIKit

/// Detail-page chrome (UI.md 2.6, 6.0.14): a scroll view under a floating top bar whose colour
/// and centred title fade in with scroll. Wrap a pushed page in it; put a `HeroHeader` (or any
/// view marked `.reportsHeroHeight()`) first so the fade span follows the hero.
///
///     DetailScaffold(title: album.name, heroColor: hero) {
///         HeroHeader(color: hero) { ... }
///         ActionRow(heroColor: hero) { ... } trailing: { ... }
///         tracks
///     }
///
/// - `progress = clamp((scrollTop - 40) / span, 0, 1)`, `span = max(120, heroHeight - 60)`,
///   160 without a hero. Bar = `color-mix(hero 55%, page)` at `progress`; title at `2p - 1`.
/// - `.artist`: the back disc (black 50 % + blur) until fully scrolled. `.liked`: never a bar
///   or title. `.solid`: Settings, bar `--bg-base` and title always on. `.hidden`: no bar.
/// - The system navigation bar is hidden; Back uses `dismiss` unless `onBack` is given.
///   The edge-swipe pop keeps working (see `UINavigationController` extension below).
struct DetailScaffold<Content: View>: View {
    enum BarStyle: Sendable { case standard, artist, liked, solid, hidden }

    var title: String
    /// The page's `--hero` (already tinted). Nil: the page has no hero.
    var heroColor: RGB?
    var barStyle: BarStyle = .standard
    var onBack: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var scrollTop: CGFloat = 0
    @State private var heroHeight: CGFloat = 0
    private let space = "detail-scroll"

    init(title: String, heroColor: RGB? = nil, barStyle: BarStyle = .standard, onBack: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title; self.heroColor = heroColor; self.barStyle = barStyle; self.onBack = onBack; self.content = content
    }

    /// The fade math, exposed for tests.
    static func progress(scrollTop: CGFloat, heroHeight: CGFloat?) -> CGFloat {
        let span = heroHeight.map { max(120, $0 - 60) } ?? 160
        return min(1, max(0, (scrollTop - 40) / span))
    }

    static func titleOpacity(_ p: CGFloat) -> CGFloat { min(1, max(0, p * 2 - 1)) }

    var body: some View {
        GeometryReader { outer in
            let topInset = outer.safeAreaInsets.top
            let hasHero = heroColor != nil && heroHeight > 0
            let p = barStyle == .solid ? 1 : Self.progress(scrollTop: scrollTop, heroHeight: hasHero ? heroHeight : nil)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if heroColor == nil { Color.clear.frame(height: Shell.topBar + topInset) }
                    content()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, Shell.contentBottom)
                .background(GeometryReader { g in
                    Color.clear.preference(key: ScrollTopKey.self, value: -g.frame(in: .named(space)).minY)
                })
            }
            .scrollIndicators(.hidden)
            .coordinateSpace(name: space)
            .ignoresSafeArea(edges: .top)
            .environment(\.detailTopInset, topInset)
            .onPreferenceChange(ScrollTopKey.self) { scrollTop = $0 }
            .onPreferenceChange(HeroHeightKey.self) { heroHeight = $0 }
            .overlay(alignment: .top) {
                if barStyle != .hidden { topBar(progress: p, topInset: topInset, hasHero: hasHero) }
            }
        }
        .background(theme.page.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private func topBar(progress p: CGFloat, topInset: CGFloat, hasHero: Bool) -> some View {
        let barColor: Color = {
            if barStyle == .solid { return theme.bgBase }
            if let h = heroColor { return h.colorMix(0.55, theme.rgb.page).color }
            return theme.page
        }()
        let showBar = barStyle != .liked
        ZStack {
            if showBar { barColor.opacity(p) }
            HStack(spacing: 0) {
                Button { (onBack ?? { dismiss() })() } label: {
                    IconView(.backChevron, size: 18).foregroundStyle(theme.fg)
                        .frame(width: 32, height: 32)
                        .background {
                            if barStyle == .artist {
                                Circle().fill(.black.opacity(p >= 1 ? 0 : 0.5)).background(.ultraThinMaterial.opacity(p >= 1 ? 0 : 1), in: Circle())
                            }
                        }
                        .animation(.linear(duration: 0.15), value: p >= 1)
                        .frame(width: 48, height: Shell.topBar)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressFade)
                .padding(.leading, Spacing.gutter - 8)
                .accessibilityLabel(L("Go back"))
                Text(title).textStyle(.barTitle).foregroundStyle(theme.fg).lineLimit(1)
                    .opacity(showBar ? (barStyle == .solid ? 1 : Self.titleOpacity(p)) : 0)
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                Color.clear.frame(width: 48 + Spacing.gutter - 8, height: 1)
            }
            .frame(height: Shell.topBar)
            .padding(.top, topInset)
        }
        .frame(height: Shell.topBar + topInset)
        .frame(maxWidth: .infinity)
        .ignoresSafeArea(edges: .top)
        .modifier(BarIsland(hero: hasHero))
    }
}

/// Over a hero the bar keeps the dark tokens; without one on a light theme it is a plain page bar.
private struct BarIsland: ViewModifier {
    let hero: Bool
    func body(content: Content) -> some View { if hero { content.heroIsland() } else { content } }
}

private struct ScrollTopKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct HeroHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct TopInsetKey: EnvironmentKey { static let defaultValue: CGFloat = 0 }

extension EnvironmentValues {
    /// Inside a `DetailScaffold`: the top safe-area inset (heroes pad by `56 + inset`).
    var detailTopInset: CGFloat {
        get { self[TopInsetKey.self] }
        set { self[TopInsetKey.self] = newValue }
    }
}

extension View {
    /// Mark the page's hero so the top bar's fade span follows its height.
    func reportsHeroHeight() -> some View {
        background(GeometryReader { g in Color.clear.preference(key: HeroHeightKey.self, value: g.size.height) })
    }

    /// Bottom padding of root scroll views so the last row clears the mini player and tab bar.
    func shellContentPadding() -> some View { padding(.bottom, Shell.contentBottom) }
}

/// Hiding the navigation bar disables the edge-swipe pop; keep it on for every pushed page
/// (DECISIONS 7: standard iOS push/pop and edge swipe).
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        g == interactivePopGestureRecognizer ? viewControllers.count > 1 : true
    }
}

#Preview("Detail scaffold") {
    NavigationStack {
        DetailScaffold(title: "OK Computer", heroColor: ColorMath.phoneHero("#1e3264")) {
            HeroHeader(color: ColorMath.phoneHero("#1e3264")!, title: "OK Computer") {
                LikedCover()
            } meta: {
                Text("Album • 1997")
            }
            ActionRow(heroColor: ColorMath.phoneHero("#1e3264")!) {
                IconButton(.heart, label: "Save") {}
                IconButton(.dots24, label: "More") {}
            } trailing: {
                IconButton(label: "Shuffle", action: {}) { ShuffleGlyph(mode: .off, size: 24) }
                BigPlayButton(playing: false) {}
            }
            ForEach(0..<20, id: \.self) { i in TrackRow(track: .preview("Track \(i)"), onMore: {}) }
        }
    }
}
