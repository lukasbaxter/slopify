import SwiftUI

/// Album page (UI.md 6.3.2-6.3.4; Library.jsx detail kind 'Album'): hero, action row, the
/// album's songs (no art, no numbers). A song link opens it with that row lit and centred.
struct AlbumView: View {
    let id: String
    var highlightTrack: String? = nil

    @Environment(AppModel.self) private var app
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(OfflineStore.self) private var offline
    @State private var model: DetailAlbumModel
    @State private var actions = DetailActions()
    @State private var scrolledToHighlight = false

    init(id: String, highlightTrack: String? = nil) {
        self.id = id
        self.highlightTrack = highlightTrack
        _model = State(initialValue: DetailAlbumModel(id: id))
    }

    private var album: Album? { model.album }
    private var context: String { id }
    private var here: Bool { player.context == context }
    private var saved: Bool { model.savedOverride ?? likes.albums.contains(id) }

    var body: some View {
        @Bindable var actions = actions
        let hero = model.hero
        ScrollViewReader { proxy in
            DetailScaffold(title: album?.name ?? "", heroColor: hero) {
                header(hero)
                ActionRow(heroColor: hero) { leadingActions } trailing: { trailingActions }
                trackList
            }
            .onChange(of: model.tracks.count) { _, _ in scrollToHighlight(proxy) }
            .onAppear { scrollToHighlight(proxy) }
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
        .detailOnLibraryChanged { await actions.refreshPlaylists() }
    }

    // MARK: Hero

    private func header(_ hero: RGB) -> some View {
        HeroHeader(color: hero, title: album?.name) {
            CoverImage(.album(id: id, art: album?.cover), size: 250, placeholder: .chip)
        } meta: {
            if let a = album, let artistId = a.artistId, !artistId.isEmpty {
                HeroOwner(name: a.artist, action: { app.nav.push(.artist(id: artistId)) }) {
                    CoverImage(.artist(id: artistId, image: nil), size: 20, shape: .circle, placeholder: .none)
                }
            }
            if let a = album {
                Text(DetailLogic.albumStats(a, tracks: model.tracks))
            }
        }
    }

    // MARK: Actions

    @ViewBuilder private var leadingActions: some View {
        IconButton(saved ? .heartFilled : .heart, on: saved, label: saved ? L("Remove from Your Library") : L("Save to Your Library")) {
            toggleSave()
        }
        if !model.tracks.isEmpty { OfflineDownloadButton(actions: download) }
        IconButton(.dots24, label: L("More options for {name}", ["name": album?.name ?? ""])) { openPageMenu() }
    }

    private var download: OfflineCollectionActions {
        OfflineCollectionActions(store: offline, id: id, name: album?.name ?? "", kind: .album, tracks: model.tracks) { [actions] in actions.confirm = $0 }
    }

    @ViewBuilder private var trailingActions: some View {
        let shuffled = player.shuffle != .off
        IconButton(on: shuffled, label: shuffled ? L("Disable shuffle") : L("Enable shuffle"), action: {
            player.setShuffle(shuffled ? .off : .on)
        }) { ShuffleGlyph(mode: .off, size: 24) }
        BigPlayButton(playing: here && player.isPlaying) {
            if here { player.togglePlay() } else if !model.tracks.isEmpty { offline.playPage(model.tracks, context: context, player: player) }
        }
        .padding(.leading, 4)
    }

    /// Save to Your Library (App.jsx onFollowAlbum): optimistic, then the saved list is re-read.
    private func toggleSave() {
        let on = !saved
        model.savedOverride = on
        let api = app.account.api
        Task {
            do {
                if on { _ = try await api.like(id) } else { try await api.unlike(id) }
                ToastCenter.shared.show(on ? L("Added to Your Library") : L("Removed from Your Library"))
                await likes.refresh()
                model.savedOverride = nil
                actions.announceLibraryChange()
            } catch {
                model.savedOverride = nil
                ToastCenter.shared.show(L("Could not update: {error}", ["error": DetailActions.message(error)]))
            }
        }
    }

    private func openPageMenu() {
        guard let a = album else { return }
        let tracks = model.tracks
        let leadId = a.artistId.flatMap { $0.isEmpty ? nil : $0 }
        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: true) { player.addToQueue(tracks) },
            MenuItem(L("Go to radio"), icon: .radio) { actions.radio(id) },
        ]
        if !tracks.isEmpty { items.append(MenuItem(L("Add to playlist"), icon: .plus, sub: actions.playlistSub(tracks: tracks, excluding: id))) }
        if let leadId { items.append(MenuItem(L("Go to artist"), icon: .artist, offline: true) { app.nav.push(.artist(id: leadId)) }) }
        items.append(MenuItem(saved ? L("Remove from Your Library") : L("Save to Your Library"), icon: saved ? .heartFilled : .heart) { toggleSave() })
        items.append(MenuItem(L("Share"), icon: .share) { actions.share(.album, id: id, title: a.name, by: leadId == nil ? nil : a.artist) })
        items += download.menuItems
        let header = MenuHeader(art: .cover(.album(id: id, art: a.cover)), title: a.name,
                                subtitle: leadId == nil ? L("Album") : a.artist)
        actions.menu = MenuSheet(header: header, items: actions.offline ? MenuItem.offlineSubset(items) : MenuItem.tidy(items))
    }

    // MARK: Tracks

    @ViewBuilder private var trackList: some View {
        let tracks = model.tracks
        if tracks.isEmpty {
            if model.loading { SkeletonRows(count: 8) }
            else if let note = model.emptyNote { PlaceholderNote(text: note) }
        } else {
            VStack(spacing: 0) {
                ForEach(Array(tracks.enumerated()), id: \.offset) { i, t in
                    let current = player.current?.id == t.id
                    TrackRow(track: t, isCurrent: current, isPlaying: current && player.isPlaying,
                             isDownloaded: offline.has(t.id),
                             isUnavailable: actions.offline && !offline.has(t.id),
                             isHighlighted: t.id == highlightTrack,
                             onTap: { current ? player.togglePlay() : offline.play(tracks, at: i, context: context, player: player) },
                             onMore: { actions.openTrackMenu(t) },
                             onTouchDown: { player.prewarm(t) })
                    .id(t.id)
                }
            }
        }
    }

    private func scrollToHighlight(_ proxy: ScrollViewProxy) {
        guard let hl = highlightTrack, !scrolledToHighlight, model.tracks.contains(where: { $0.id == hl }) else { return }
        scrolledToHighlight = true
        DispatchQueue.main.async { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(hl, anchor: .center) } }
    }
}
