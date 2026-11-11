import SwiftUI

/// Daily Mix / Your Top Songs page (UI.md 6.3.6): opens at once with skeleton rows, the Home
/// tile composite as cover, mix mark + "Made for you", ⋯ | Shuffle, Play, rows with art.
struct HomeMixPage: View {
    /// Player context: `mix:<artistId>` or `top:<year>`.
    var context: String
    var title: String
    var sub: String?
    var color: RGB
    var art: CoverSource?
    var radioSeed: String?
    var load: @MainActor (APIClient) async throws -> [Track]

    @Environment(AppModel.self) private var app
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Navigator.self) private var nav
    @Environment(Likes.self) private var likes

    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var failure: HomeMixPageFailure?
    @State private var menu: MenuSheet?
    @State private var nameDialog: NameDialog?

    private var hero: RGB { ColorMath.heroTint(color) }
    private var isContext: Bool { player.context == context }

    var body: some View {
        DetailScaffold(title: title, heroColor: hero) {
            HeroHeader(color: hero, title: title, coverSize: 208) {
                HomeMixArt(source: art, color: color, label: title, large: true, pixelSize: 208)
            } meta: {
                HeroOwner(name: L("Made for you")) { HomeMixMark(color: color) }
                Text(HomeLogic.mixStats(sub: sub, totalMs: tracks.reduce(0) { $0 + $1.durationMs }))
            }
            ActionRow(heroColor: hero) {
                IconButton(.dots24, label: L("More options")) { menu = menus.mixPage(title: title, art: art, tracks: tracks, radioSeed: radioSeed) }
            } trailing: {
                let shuffleOn = player.shuffle != .off
                IconButton(on: shuffleOn, label: shuffleOn ? L("Disable shuffle") : L("Enable shuffle"), action: {
                    player.setShuffle(shuffleOn ? .off : .on)
                }) { ShuffleGlyph(mode: player.shuffle == .smart ? .smart : shuffleOn ? .on : .off, size: 24) }
                BigPlayButton(playing: isContext && player.isPlaying) { playPage() }
                    .padding(.leading, 4)
            }
            if let failure, case .error(let m) = failure { ErrorBanner(message: m).pageBanner() }
            rows
        }
        .contextMenuSheet($menu)
        .nameDialog($nameDialog)
        .task(id: context) { await fetch() }
    }

    @ViewBuilder private var rows: some View {
        if loading && tracks.isEmpty {
            SkeletonRows(count: 8, art: true)
        } else if tracks.isEmpty {
            PlaceholderNote(text: failure == .offline ? L("Not available offline. Open it once with a connection, or download it.")
                                : failure != nil ? L("Couldn’t load this — try again.") : L("Nothing here yet."))
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(tracks.enumerated()), id: \.offset) { i, t in
                    TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id,
                             isPlaying: player.isPlaying,
                             onTap: { playRow(i) },
                             onMore: { menu = trackMenus.sheet(t) },
                             onArt: { nav.push(.album(id: t.albumId)) },
                             onTouchDown: { player.prewarm(t) })
                }
            }
        }
    }

    private var trackMenus: TrackMenuBuilder { TrackMenuBuilder(app: app) { nameDialog = $0 } }
    private var menus: HomeMenus { HomeMenus(menus: trackMenus) }

    private func fetch() async {
        loading = true
        do {
            let items = try await load(account.api)
            guard !Task.isCancelled else { return }
            tracks = StreamPolicy.dropDisliked(items, prefs: account.prefs)
            failure = nil
        } catch {
            guard !Task.isCancelled else { return }
            failure = HomeMixPageFailure(error)
        }
        loading = false
    }

    /// The page's play button: toggle when this page is playing, else play from the top.
    private func playPage() {
        if isContext { player.togglePlay(); return }
        guard !tracks.isEmpty else { return }
        player.play(tracks, startAt: 0, context: context)
    }

    private func playRow(_ i: Int) {
        if player.current?.id == tracks[i].id { player.togglePlay(); return }
        player.play(tracks, startAt: i, context: context)
    }
}

/// Why a mix page has no rows. Offline shows its own note and no banner (Library.jsx `e.offline`).
enum HomeMixPageFailure: Equatable {
    case offline
    case error(String)

    init(_ e: Error) {
        if case APIError.offline = e { self = .offline } else { self = .error(HomeStore.message(e)) }
    }
}
