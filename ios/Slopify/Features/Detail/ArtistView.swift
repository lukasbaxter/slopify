import SwiftUI

/// Artist page (UI.md 6.3.7; Library.jsx detail kind 'Artist'): banner hero, Follow / ⋯ |
/// Shuffle / Play, then Popular, Popular releases or Discography, Appears On, Fans also like.
struct ArtistView: View {
    let id: String

    @Environment(AppModel.self) private var app
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(OfflineStore.self) private var offline
    @Environment(\.theme) private var theme
    @State private var model: DetailArtistModel
    @State private var actions = DetailActions()
    @State private var popularExpanded = false
    @State private var discoOpen = false

    init(id: String) {
        self.id = id
        _model = State(initialValue: DetailArtistModel(id: id))
    }

    private var here: Bool { player.context == model.context }
    private var following: Bool { model.followOverride ?? (likes.artists.contains(id) || model.followed) }

    var body: some View {
        @Bindable var actions = actions
        Group {
            if actions.offline && !model.loading && model.artist == nil {
                offlineEmpty
            } else {
                page
            }
        }
        .overlay(alignment: .top) { DetailErrorBanner(error: $actions.error) }
        .contextMenuSheet($actions.menu)
        .nameDialog($actions.nameDialog)
        .confirmDialog($actions.confirm)
        .task {
            actions.attach(app)
            let api = app.account.api
            let colour = Task { await model.sampleColour(api: api) }
            let lists = Task { await actions.refreshPlaylists() }
            await model.load(api: api, scope: app.account.user?.id)
            await colour.value
            await lists.value
        }
        .task(id: model.hasPending) { await pollRequests() }
        .detailOnLibraryChanged { await actions.refreshPlaylists() }
    }

    private var page: some View {
        let hero = model.hero
        return DetailScaffold(title: model.artist?.name ?? "", heroColor: hero, barStyle: .artist,
                              onRefresh: { await model.load(api: app.account.api, scope: app.account.user?.id) }) {
            ArtistHero(model: model, hero: hero)
            ActionRow(heroColor: hero, artist: true) {
                FollowPill(following: following) { toggleFollow() }
                    .accessibilityLabel(following ? L("Unfollow") : L("Follow"))
                    .padding(.trailing, 4)
                IconButton(.dots24, label: L("More options for {name}", ["name": model.artist?.name ?? ""])) { openPageMenu() }
            } trailing: {
                let shuffled = player.shuffle != .off
                IconButton(on: shuffled, label: shuffled ? L("Disable shuffle") : L("Enable shuffle"), action: {
                    player.setShuffle(shuffled ? .off : .on)
                }) { ShuffleGlyph(mode: .off, size: 24) }
                BigPlayButton(playing: here && player.isPlaying) {
                    if here { player.togglePlay() } else if !model.tracks.isEmpty { offline.playPage(model.tracks, context: model.context, player: player) }
                }
                .padding(.leading, 4)
            }
            VStack(alignment: .leading, spacing: 0) {
                popularSection
                if discoOpen {
                    DetailDiscographySection(model: model, onOpen: openAlbum, onRequest: request, onRetry: reloadDiscography)
                } else {
                    releasesSection
                }
                appearsOnSection
                similarSection
                // "About" needs `Overview`, which the API does not send (Spec issues).
            }
            .padding(.top, 8)
        }
    }

    // MARK: Popular

    @ViewBuilder private var popularSection: some View {
        let tracks = model.tracks
        SectionHeader(L("Popular"), style: .artist, first: true)
        VStack(spacing: 0) {
            ForEach(Array(tracks.prefix(popularExpanded ? 10 : 5).enumerated()), id: \.offset) { i, t in
                let current = player.current?.id == t.id
                TrackRow(track: t, showArt: true, number: i + 1, isCurrent: current, isPlaying: current && player.isPlaying,
                         isDownloaded: offline.has(t.id),
                         isUnavailable: actions.offline && !offline.has(t.id),
                         subtitle: DetailLogic.playsSubtitle(t, locale: Localizer.shared.locale),
                         onTap: { current ? player.togglePlay() : offline.play(tracks, at: i, context: model.context, player: player) },
                         onMore: { actions.openTrackMenu(t) },
                         onArt: { app.nav.push(.album(id: t.albumId)) },
                         onTouchDown: { player.prewarm(t) })
            }
        }
        if tracks.count > 5 {
            DetailOutlinePill(popularExpanded ? L("Show less") : L("See more")) { popularExpanded.toggle() }
                .padding(.top, 8).padding(.horizontal, Spacing.gutter)
        }
    }

    // MARK: Popular releases (phone default)

    @ViewBuilder private var releasesSection: some View {
        let all = model.entries
        let top = Array(DetailLogic.newestFirst(all).prefix(5))
        if !all.isEmpty || model.discog == .loading || model.discog == .failed {
            SectionHeader(L("Popular releases"), style: .artist)
            if model.discog == .loading && top.isEmpty { PlaceholderNote(text: L("Loading…")) }
            if model.discog == .failed { DetailDiscographyFailedNote(offline: actions.offline) { reloadDiscography() } }
            VStack(spacing: 0) {
                ForEach(top) { e in
                    DetailReleaseRow(entry: e, request: model.requestState(e), onOpen: openAlbum, onRequest: request)
                }
            }
            .padding(.horizontal, Spacing.gutter)
            if !all.isEmpty {
                DetailOutlinePill(L("See discography")) { discoOpen = true }
                    .padding(.top, 12).padding(.bottom, 4).padding(.horizontal, Spacing.gutter)
            }
        }
    }

    // MARK: Appears On / Fans also like

    @ViewBuilder private var appearsOnSection: some View {
        if !model.appearsOn.isEmpty {
            SectionHeader(L("Appears On"), style: .artist)
            Shelf(items: model.appearsOn) { a in
                MediaCard(.init(a), title: a.name, subtitle: a.artist) { app.nav.push(.album(id: a.id)) } onLongPress: {
                    actions.menu = CardMenuBuilder(app: app).album(a.id, name: a.name, artist: a.artist, artistId: a.artistId)
                }
            }
        }
    }

    @ViewBuilder private var similarSection: some View {
        let similar = model.similar.compactMap { s in s.id.map { SimilarArtist(id: $0, name: s.name) } }
        if !similar.isEmpty {
            SectionHeader(L("Fans also like"), style: .artist)
            Shelf(items: similar) { a in
                MediaCard(.artist(id: a.id, image: nil), title: a.name, subtitle: L("Artist"), round: true) { app.nav.push(.artist(id: a.id)) } onLongPress: {
                    actions.menu = CardMenuBuilder(app: app).artist(a.id, name: a.name)
                }
            }
        }
    }

    // MARK: Offline, never opened (Library.jsx:1113-1120)

    private var offlineEmpty: some View {
        VStack(spacing: 8) {
            Text(L("Not available offline")).font(.system(size: 20, weight: .bold)).foregroundStyle(theme.fg)
            Text(L("Open this artist once with a connection, and they show up here offline too."))
                .font(.system(size: 14)).foregroundStyle(theme.fgSub).lineSpacing(4)
                .multilineTextAlignment(.center).frame(maxWidth: 320)
        }
        .padding(.vertical, 120).padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(theme.page.ignoresSafeArea())
    }

    // MARK: Actions

    private func openAlbum(_ albumId: String) { app.nav.push(.album(id: albumId)) }

    private func reloadDiscography() {
        Task { await model.loadDiscography(api: app.account.api) }
    }

    private func request(_ e: DetailLogic.Entry) {
        Task {
            do { try await model.request(e, api: app.account.api) }
            catch { actions.error = DetailActions.message(error) }
        }
    }

    /// While a request is on its way, look again every 5 s for up to 30 minutes.
    private func pollRequests() async {
        guard model.hasPending else { return }
        let started = Date()
        while !Task.isCancelled, model.hasPending, Date().timeIntervalSince(started) < 30 * 60 {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if Task.isCancelled { return }
            await model.refreshDiscography(api: app.account.api)
        }
    }

    /// Optimistic follow; reverts and shows the banner on failure (Library.jsx toggleFollow).
    private func toggleFollow() {
        let on = !following
        model.followOverride = on
        let api = app.account.api
        Task {
            do {
                if on { _ = try await api.like(id) } else { try await api.unlike(id) }
                await likes.refresh()
                model.followOverride = nil
                NotificationCenter.default.post(name: .libraryChanged, object: nil)
            } catch {
                model.followOverride = !on
                actions.error = DetailActions.message(error)
            }
        }
    }

    private func openPageMenu() {
        guard let a = model.artist else { return }
        let tracks = model.tracks
        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: true) { player.addToQueue(tracks) },
            MenuItem(following ? L("Unfollow") : L("Follow"), icon: .follow) { toggleFollow() },
            MenuItem(L("Go to radio"), icon: .radio) { actions.radio(id, name: a.name) },
        ]
        if !tracks.isEmpty { items.append(MenuItem(L("Add to playlist"), icon: .plus, sub: actions.playlistSub(tracks: tracks))) }
        items.append(MenuItem(L("Share"), icon: .share) { actions.share(.artist, id: id, title: a.name, by: nil) })
        let header = MenuHeader(art: .cover(.init(a), round: true), title: a.name, subtitle: L("Artist"))
        actions.menu = MenuSheet(header: header, items: actions.offline ? MenuItem.offlineSubset(items) : MenuItem.tidy(items))
    }
}

private struct SimilarArtist: Identifiable { let id: String; let name: String }

/// The artist hero (UI.md 6.3.7): at least 300 pt, content at the bottom, the banner melting into
/// the action-row band (or a flat `--hero`), verified badge, 48 pt name, song count.
private struct ArtistHero: View {
    let model: DetailArtistModel
    let hero: RGB
    @Environment(\.theme) private var theme
    @Environment(\.apiClient) private var api
    @State private var width: CGFloat = 393

    private var bannerURL: URL? {
        guard let a = model.artist else { return nil }
        // Phone: the 640 px copy (`bannerWidth`); the portrait when there is no wide photo.
        if a.banner != nil { return CoverSource.banner(artistId: a.id).url(api, size: 640) }
        if a.image != nil { return CoverSource.artist(id: a.id, image: a.image).url(api, size: 640) }
        return nil
    }

    var body: some View {
        let banner = model.hasBanner
        let shadow = Color.black.opacity(banner ? 0.5 : 0)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                IconView(.verified, size: 18).foregroundStyle(Theme.Fixed.verified)
                Text(L("Verified Artist")).font(.system(size: 12, weight: .bold)).foregroundStyle(Color.white)
            }
            .shadow(color: shadow, radius: 6, y: 2)
            .padding(.bottom, 4)
            if let name = model.artist?.name {
                let size: CGFloat = width <= 380 ? 34 : 48
                Text(name)
                    .font(.system(size: size, weight: .bold))
                    .lineSpacing(size * 0.05 - (UIFont.systemFont(ofSize: size, weight: .bold).lineHeight - size))
                    .foregroundStyle(Color.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .shadow(color: shadow, radius: 6, y: 2)
                    .padding(.bottom, 4)
            } else {
                SkeletonTitle()
            }
            Text(L("{n} songs in your library", ["n": model.tracks.count]))
                .font(.system(size: 13)).foregroundStyle(Color.white)
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, minHeight: 300, alignment: .bottomLeading)
        .background {
            if banner {
                DetailFocalImage(url: bannerURL, x: 0.5, y: 0.25)
                    .overlay(LinearGradient(stops: [
                        .init(color: .clear, location: 0.3),
                        .init(color: .black.opacity(0.35), location: 0.7),
                        .init(color: hero.colorMix(0.8, theme.rgb.page).color, location: 1),
                    ], startPoint: .top, endPoint: .bottom))
                    .background(hero.color)
            } else {
                hero.color
            }
        }
        .background(GeometryReader { g in
            Color.clear.onAppear { width = g.size.width }.onChange(of: g.size.width) { _, w in width = w }
        })
        .heroIsland()
        .reportsHeroHeight()
    }
}
