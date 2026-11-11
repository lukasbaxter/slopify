import SwiftUI

/// Release Radar page (UI.md 6.3.9): new releases (90 days) from the artists you like, as a
/// two-column grid. Owned releases open their album; missing ones carry a Request pill and link
/// the artist. Paints the kept list at once, then asks the server again.
struct ReleaseRadarView: View {
    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme

    @State private var store = HomeStore.shared
    /// album_id -> this client's request state (`queued`, `exists`, `error`).
    @State private var requesting: [String: String] = [:]
    @State private var error: String?

    private var hero: RGB { ColorMath.heroTint(Theme.Fixed.radarHero) }

    var body: some View {
        let rels = store.data.radar
        let known = store.radarLoaded || !rels.isEmpty
        DetailScaffold(title: L("Release Radar"), heroColor: hero) {
            RadarHero(color: hero, meta: known
                      ? L("{n} new releases from the artists you like • last 90 days", ["n": rels.count])
                      : L("Checking the last 90 days for the artists you like…"))
            // `.actions.slim`: no buttons, only the colour band behind the first rows.
            Color.clear.frame(height: 8)
                .background(alignment: .top) {
                    LinearGradient(colors: [hero.colorMix(0.7, theme.rgb.page).color, theme.bgBase], startPoint: .top, endPoint: .bottom)
                        .frame(height: 8 + 230)
                        .allowsHitTesting(false)
                }
                .zIndex(-1)
            VStack(alignment: .leading, spacing: 0) {
                if let error { ErrorBanner(message: error) { self.error = nil }.pageBanner() }
                if store.radarLoaded && rels.isEmpty {
                    PlaceholderNote(text: L("Nothing new from your artists in the last 90 days."))
                } else if !rels.isEmpty {
                    CardGrid(items: rels) { r in card(r) }
                }
            }
            .padding(.top, 8)
        }
        .task {
            store.use(key: HomeStore.key(for: account))
            await store.reloadRadar(api: account.api)
            if let e = store.radarError, store.data.radar.isEmpty { error = e }
        }
    }

    @ViewBuilder private func card(_ r: Release) -> some View {
        if let lib = r.inLibrary {
            MediaCard(.album(id: lib, art: nil), title: r.title, subtitle: HomeLogic.radarOwnedSub(r), artSize: 175) {
                nav.push(.album(id: lib))
            }
        } else {
            let ui = HomeLogic.requestUI(HomeLogic.requestState(server: r.requestStatus, mine: r.album_id.flatMap { requesting[$0] }))
            RadarMissingCard(release: r, request: RequestPill(title: ui.label, busy: ui.busy) { request(r) }) {
                if let a = r.artistId { nav.push(.artist(id: a)) }
            }
        }
    }

    private func request(_ r: Release) {
        guard let id = r.album_id else { return }
        requesting[id] = "queued"
        Task {
            do {
                let status = try await account.api.requestAlbum(id) ?? "queued"
                requesting[id] = status
                store.setRequestStatus(id, status)
            } catch {
                requesting[id] = "error"
                self.error = HomeStore.message(error)
            }
        }
    }
}

/// `.hero.browse-hero` without a cover: padding `56 + inset` 16 8, 24/700 title, 13 pt meta at 70 % white.
private struct RadarHero: View {
    var color: RGB
    var meta: String
    @Environment(\.detailTopInset) private var topInset
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(L("Release Radar")).textStyle(.pageTitle).foregroundStyle(theme.heroIsland.fg)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 6)
            Text(meta).font(.system(size: 13)).foregroundStyle(theme.heroIsland.fg.opacity(0.7))
        }
        .padding(.top, Shell.topBar + topInset)
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            color.color.overlay(LinearGradient(colors: [theme.page(0), theme.page(0.3)], startPoint: .top, endPoint: .bottom))
        }
        .heroIsland()
        .reportsHeroHeight()
    }
}

/// `.card.missing` on the Radar page: dimmed art with a centred Request pill; the subtitle's
/// artist name links to the artist. The card itself does not open anything (Library.jsx).
private struct RadarMissingCard: View {
    let release: Release
    let request: RequestPill
    var openArtist: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CoverImage(.url(release.image.flatMap(URL.init(string:))), size: 175, shape: .rounded(Radius.card), placeholder: .cardHover, fade: false)
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .grayscale(0.6)
                .colorMultiply(Color(white: 0.55))
                .overlay { request }
            Text(release.title)
                .textStyle(TextStyle(size: 14, weight: .bold, lineHeight: 1.4))
                .foregroundStyle(theme.fgDim)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            subtitle
                .textStyle(.cardSub)
                .foregroundStyle(theme.fgDim)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
                .environment(\.openURL, OpenURLAction { _ in openArtist(); return .handled })
        }
        .frame(maxHeight: .infinity, alignment: .top)
    }

    private var subtitle: Text {
        var name = AttributedString(release.artistName ?? "")
        if release.artistId != nil, let u = URL(string: "slopify-home:artist") {
            name.link = u
            name.foregroundColor = theme.fgDim
        }
        return Text(name) + Text(HomeLogic.radarMissingTail(release))
    }
}
