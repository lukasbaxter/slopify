import SwiftUI

/// Album / playlist / Liked / mix header (UI.md 6.3.2): `--hero` background with a
/// `rgba(page,0) -> rgba(page,.3)` wash, padding `56 + inset` 16 4, centred cover 250 pt
/// (220 at <= 380 wide, capped at width - 64) radius 4 with a deep shadow, then the 24/700
/// title and a meta column (13 pt `--fg-sub`, gap 6). Dark tokens on light themes.
struct HeroHeader<Cover: View, Meta: View>: View {
    var color: RGB
    var title: String?
    /// Liked Songs uses a 180 pt cover.
    var coverSize: CGFloat? = nil
    var onTitleTap: (() -> Void)? = nil
    @ViewBuilder var cover: () -> Cover
    @ViewBuilder var meta: () -> Meta

    @Environment(\.detailTopInset) private var topInset
    @Environment(\.theme) private var theme

    init(color: RGB, title: String?, coverSize: CGFloat? = nil, onTitleTap: (() -> Void)? = nil,
         @ViewBuilder cover: @escaping () -> Cover, @ViewBuilder meta: @escaping () -> Meta) {
        self.color = color; self.title = title; self.coverSize = coverSize; self.onTitleTap = onTitleTap
        self.cover = cover; self.meta = meta
    }

    /// 250, 220 on narrow screens, never wider than `width - 64`.
    static func coverSide(width: CGFloat) -> CGFloat { min(width <= 380 ? 220 : 250, width - 64) }

    @State private var width: CGFloat = 393

    var body: some View {
        let side = coverSize ?? Self.coverSide(width: width)
        VStack(alignment: .leading, spacing: 0) {
            cover()
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: Radius.art))
                .shadow(color: .black.opacity(0.55), radius: 18, y: 8)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 16)
            Group {
                if let title {
                    Text(title).textStyle(.pageTitle).foregroundStyle(Color.white)
                        .fixedSize(horizontal: false, vertical: true)
                        .onTapGesture { onTitleTap?() }
                } else {
                    SkeletonTitle()
                }
            }
            .padding(.bottom, 6)
            VStack(alignment: .leading, spacing: 6) { meta() }
                .font(.system(size: 13)).foregroundStyle(theme.heroIsland.fgSub)
        }
        .padding(.top, Shell.topBar + topInset)
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            color.color
                .overlay(LinearGradient(colors: [theme.page(0), RGB(hex: 0x121212, alpha: 0.3).color], startPoint: .top, endPoint: .bottom))
        }
        .background(GeometryReader { g in
            Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { _, w in width = w }
        })
        .heroIsland()
        .reportsHeroHeight()
    }
}

/// The owner line in a hero (`.hero-owner`): 20 pt avatar + bold white 13 pt name.
struct HeroOwner<Avatar: View>: View {
    var name: String
    var action: (() -> Void)? = nil
    @ViewBuilder var avatar: () -> Avatar

    var body: some View {
        HStack(spacing: 6) {
            avatar().frame(width: 20, height: 20).clipShape(Circle())
            Text(name).font(.system(size: 13, weight: .bold)).foregroundStyle(Color.white)
                .onTapGesture { action?() }
        }
    }
}

/// The colour band and action row under a hero (UI.md 6.3.3). The band starts at the row's top
/// and runs 230 pt below it: `color-mix(hero 70%, page) -> page` (artist pages 80 %), behind the
/// first rows. Row: padding 8/16, min height 64, gap 4; leading group, then trailing group
/// pushed right (shuffle, then play with 4 pt lead and -4 pt trailing margin).
struct ActionRow<Leading: View, Trailing: View>: View {
    var heroColor: RGB
    var artist = false
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.theme) private var theme

    init(heroColor: RGB, artist: Bool = false, @ViewBuilder leading: @escaping () -> Leading, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.heroColor = heroColor; self.artist = artist; self.leading = leading; self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: 4) {
            leading()
            Spacer(minLength: 0)
            trailing()
        }
        .padding(.vertical, 8)
        .padding(.leading, Spacing.gutter)
        .padding(.trailing, Spacing.gutter - 4)
        .frame(minHeight: 64)
        .background(alignment: .top) {
            GeometryReader { g in
                LinearGradient(colors: [heroColor.colorMix(artist ? 0.8 : 0.7, theme.rgb.page).color, theme.page], startPoint: .top, endPoint: .bottom)
                    .frame(height: g.size.height + 230)
            }
            .allowsHitTesting(false)
        }
        .zIndex(-1)
    }
}
