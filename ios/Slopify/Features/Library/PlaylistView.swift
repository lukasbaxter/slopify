import SwiftUI

/// A user playlist (UI.md 6.3.2-6.3.4, 6.3.11): hero with the cover and title as "Edit details"
/// buttons, action row, the songs (art, ⋯ with "Remove from this playlist"), Recommended.
/// Songs reorder by hold-to-drag, the same feel as Your Library: hold lifts the row, the others
/// slide aside, the list scrolls near the edges, the drop saves `{from, to}`; hold and let go
/// without moving opens the song menu (owner decision, DECISIONS: reorder works by touch).
struct PlaylistView: View {
    let id: String

    @Environment(AppModel.self) private var app
    @Environment(Navigator.self) private var nav
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(SessionClient.self) private var session
    @Environment(OfflineStore.self) private var offline
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var store = LibraryStore.shared
    @State private var playlist: Playlist?
    @State private var entries: [LibraryPlaylistEntry] = []
    @State private var loading = true
    @State private var failed = false
    @State private var hero: RGB?
    @State private var menu: MenuSheet?
    @State private var nameDialog: NameDialog?
    @State private var confirm: ConfirmDialog?
    @State private var editing: LibraryEditDetails?
    @State private var drag = LibraryDragController()
    @State private var listWidth: CGFloat = 0
    @State private var reco: [Track] = []
    @State private var recoLoading = false
    @State private var recoGen = 0

    private var menus: TrackMenuBuilder { TrackMenuBuilder(app: app) { nameDialog = $0 } }
    private var ctx: LibraryContext { LibraryContext(api: account.api, account: account, player: player, likes: likes, nav: nav, session: session) }
    private var tracks: [Track] { entries.map(\.track) }
    private var name: String? { playlist?.name ?? store.playlists.first { $0.id == id }?.name }
    private var heroColor: RGB { hero ?? ColorMath.detailHero() }

    var body: some View {
        page
        .contextMenuSheet($menu)
        .nameDialog($nameDialog)
        .confirmDialog($confirm)
        .overlayCover(item: $editing) { e, close in
            LibraryEditDetailsDialog(edit: e, close: close) { name, jpeg in
                guard let p = playlist else { return }
                Task {
                    if await store.edit(p, name: name, jpeg: jpeg) {
                        if jpeg != nil, let url = coverURL { ImageLoader.shared.evict(url) }
                        await load()
                    }
                }
            }
        }
        .task {
            ctx.attachStore()
            if let d = store.details[id] { apply(d) }
            await load()
            openPendingEdit()
        }
        .onChange(of: store.revision[id]) { _, _ in Task { await load() } }
    }

    private var page: some View {
        DetailScaffold(title: name ?? "", heroColor: heroColor, onRefresh: { await load() }) {
            HeroHeader(color: heroColor, title: name, onTitleTap: openEdit) {
                Button(action: openEdit) {
                    CoverImage(.playlist(id: id, cover: playlist?.cover), size: 250, shape: .rounded(Radius.art), placeholder: .cardHover)
                }
                .buttonStyle(.pressPlain)
                .accessibilityLabel(L("Choose photo"))
            } meta: {
                HeroOwner(name: account.user?.name ?? L("You"), action: { nav.push(.profile) }) {
                    Avatar(userId: account.user?.id, name: account.user?.name, size: 20, drawer: true)
                }
                if !loading || !entries.isEmpty { Text(LibraryText.playlistStats(tracks: tracks)) }
            }
            ActionRow(heroColor: heroColor) {
                if !tracks.isEmpty { OfflineDownloadButton(actions: download) }
                IconButton(.dots24, label: L("More options")) { menu = heroMenu() }
            } trailing: {
                IconButton(on: player.shuffle != .off, label: player.shuffle == .off ? L("Enable shuffle") : L("Disable shuffle"), action: ctx.toggleShuffle) {
                    ShuffleGlyph(mode: player.shuffle == .smart ? .smart : player.shuffle == .on ? .on : .off, size: 24)
                }
                BigPlayButton(playing: ctx.isPlayingPage(id)) { ctx.playPage(tracks, context: id) }
                    .padding(.leading, 4)
            }
            trackList
            recommended
        }
    }

    // MARK: - Songs

    @ViewBuilder
    private var trackList: some View {
        let offline = ctx.offline
        if entries.isEmpty && loading {
            SkeletonRows(count: 8, art: true)
        } else if entries.isEmpty {
            PlaceholderNote(text: failed
                ? (offline ? L("Not available offline. Open it once with a connection, or download it.") : L("Couldn’t load this — try again."))
                : L("This playlist is empty."))
        } else {
            LazyVStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.key) { i, e in
                    let key = e.key.uuidString
                    let lifted = drag.lift?.id == key
                    TrackRow(track: e.track, showArt: true, isCurrent: player.current?.id == e.track.id, isPlaying: player.isPlaying,
                             isDownloaded: self.offline.has(e.track.id),
                             isUnavailable: offline && !self.offline.has(e.track.id),
                             onTap: { ctx.play(tracks, at: i, context: id) },
                             onMore: { menu = trackMenu(e) },
                             onArt: { if !e.track.albumId.isEmpty { nav.push(.album(id: e.track.albumId)) } },
                             onTouchDown: { player.prewarm(e.track) })
                        .frame(height: Shell.trackRow)
                        .background { if lifted { theme.cardHover.shadow(color: .black.opacity(0.45), radius: 12, y: 8) } }
                        .scaleEffect(lifted ? 1.02 : 1)
                        .offset(drag.offset(for: key))
                        .zIndex(lifted ? 1 : 0)
                        .animation(lifted ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.18), value: drag.lift?.target)
                }
            }
            .overlay(alignment: .topLeading) { songDropLine }
            .background(GeometryReader { g in
                Color.clear.onAppear { listWidth = g.size.width }.onChange(of: g.size.width) { _, w in listWidth = w }
            })
            // The hold-to-drag recognizer goes on the page's scroll view; points are in this list's space.
            .background(LibraryDragProbe(drag: drag))
            .onAppear { wireDrag() }
        }
    }

    @ViewBuilder
    private var songDropLine: some View {
        if let r = drag.dropLine {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1).fill(theme.accentInk).frame(width: r.width, height: 2)
                Circle().fill(theme.page).overlay(Circle().strokeBorder(theme.accentInk, lineWidth: 2))
                    .frame(width: 8, height: 8).offset(x: -4)
            }
            .offset(x: r.minX, y: r.minY)
            .allowsHitTesting(false)
        }
    }

    // MARK: - Hold to drag

    /// The rows (fixed 64 pt, so the lazy list needs no measuring) and what a drop or hold does.
    private func wireDrag() {
        drag.rows = { songRows() }
        drag.canEnter = { _ in false }
        drag.coveredTop = Shell.topBar
        drag.coveredBottom = Shell.contentBottom - 24
        drag.onFinish = { finishSongDrag($0) }
    }

    /// Nothing to arrange (one song, or offline): only the held row, so a hold is just the menu.
    private func songRows() -> [LibraryDrag.Row] {
        let all = entries.enumerated().map { i, e in
            LibraryDrag.Row(id: e.key.uuidString, folder: false,
                            rect: CGRect(x: 0, y: CGFloat(i) * Shell.trackRow, width: listWidth, height: Shell.trackRow))
        }
        return all
    }

    private func finishSongDrag(_ outcome: LibraryDragController.Outcome?) {
        let canMove = entries.count > 1 && !ctx.offline
        switch outcome {
        case .hold(let key):
            if let e = entries.first(where: { $0.key.uuidString == key }) { menu = trackMenu(e) }
        case let .drop(key, to, _, rows):
            guard canMove, let from = rows.firstIndex(of: key) else { return }
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { move(from: from, to: to) }
        case nil:
            break
        }
    }

    private func trackMenu(_ e: LibraryPlaylistEntry) -> MenuSheet {
        menus.sheet(e.track, remove: { _ in remove(e) })
    }

    // MARK: - Recommended (6.3.4)

    @ViewBuilder
    private var recommended: some View {
        if !loading && !ctx.offline && (recoLoading || !reco.isEmpty) {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Recommended")).textStyle(.sectionDetail).foregroundStyle(theme.fg)
                    Text(L("Based on what’s in this playlist")).font(.system(size: 13)).foregroundStyle(theme.fgSub)
                }
                .padding(.horizontal, Spacing.gutter).padding(.bottom, 8)
                if recoLoading && reco.isEmpty {
                    PlaceholderNote(text: L("Finding songs…"))
                } else {
                    ForEach(reco) { t in
                        HStack(spacing: 0) {
                            TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id,
                                     onTap: { ctx.play(reco, at: reco.firstIndex(of: t) ?? 0, context: id) },
                                     onArt: { nav.push(.album(id: t.albumId)) },
                                     onTouchDown: { player.prewarm(t) })
                                .padding(.trailing, -Spacing.gutter)
                            Button { addRecommended(t) } label: {
                                Text(L("Add")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                                    .padding(.horizontal, 16).frame(minHeight: 32)
                                    .overlay(Capsule().strokeBorder(theme.fgDim, lineWidth: 1))
                                    .contentShape(Capsule())
                            }
                            .buttonStyle(.pressFade)
                            .padding(.leading, 12)
                            .padding(.trailing, Spacing.gutter)
                        }
                    }
                    Button { recoGen += 1; Task { await loadRecommended() } } label: {
                        Text(L("Refresh")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                            .padding(.vertical, 14).padding(.horizontal, 16)
                    }
                    .buttonStyle(.pressFade)
                }
            }
            .padding(.top, 24 + 16)
        }
    }

    // MARK: - Data

    private func apply(_ d: PlaylistDetail) {
        let keep = entries.map(\.track.id) == d.tracks.map(\.id)
        playlist = d.playlist
        if !keep { entries = d.tracks.map { LibraryPlaylistEntry(track: $0) } }
    }

    private func load() async {
        do {
            let d = try await account.api.playlist(id)
            store.remember(d)
            apply(d)
            failed = false
        } catch {
            // Offline and never opened in this run: the downloaded songs still show.
            let held = offline.downloadedTracks(of: id)
            if entries.isEmpty && !held.isEmpty { entries = held.map { LibraryPlaylistEntry(track: $0) } }
            failed = entries.isEmpty
        }
        loading = false
        await sampleHero()
        if reco.isEmpty { await loadRecommended() }
    }

    private var coverURL: URL? { account.api.imageURL(id: id, size: 120, bust: playlist?.cover) }

    private func sampleHero() async {
        let sampled = await ArtworkColor.shared.vibrant(coverURL)
        hero = ColorMath.detailHero(sampled: sampled)
    }

    private func loadRecommended() async {
        guard !ctx.offline else { return }
        recoLoading = true
        defer { recoLoading = false }
        let items = (try? await account.api.playlistRecommended(id, limit: 10, seed: recoGen)) ?? []
        reco = StreamPolicy.dropDisliked(items, prefs: account.prefs)
    }

    private func addRecommended(_ t: Track) {
        reco.removeAll { $0.id == t.id }
        Task {
            do {
                try await account.api.addToPlaylist(id, trackIds: [t.id])
                await load()
                await store.refreshPlaylists()
            } catch {
                ToastCenter.shared.show(L("Could not add: {error}", ["error": error.localizedDescription]))
            }
        }
    }

    /// Positions are the shown index (API.md gotcha 7).
    private func remove(_ e: LibraryPlaylistEntry) {
        guard let pos = entries.firstIndex(where: { $0.key == e.key }) else { return }
        entries.remove(at: pos)
        Task {
            do {
                try await account.api.removeFromPlaylist(id, positions: [pos])
                ToastCenter.shared.show(L("Removed from playlist"))
                await store.refreshPlaylists()
            } catch {
                ToastCenter.shared.show(L("Could not remove: {error}", ["error": error.localizedDescription]))
                await load()
            }
        }
    }

    /// Optimistic: move here first (final indexes, the web's splice), then tell the server;
    /// toast and reload on failure.
    private func move(from: Int, to: Int) {
        guard from != to, entries.indices.contains(from), entries.indices.contains(to) else { return }
        entries = LibraryText.moved(entries, from: from, to: to)
        Task {
            do { try await account.api.movePlaylistTrack(id, from: from, to: to) }
            catch {
                ToastCenter.shared.show(L("Could not reorder: {error}", ["error": error.localizedDescription]))
                if let d = try? await account.api.playlist(id) { entries = d.tracks.map { LibraryPlaylistEntry(track: $0) } }
            }
        }
    }

    // MARK: - Menus and dialogs

    private func heroMenu() -> MenuSheet {
        let ctx = ctx
        let tracks = tracks
        let p = playlist
        let title = name ?? ""
        var items: [MenuItem] = [
            MenuItem(L("Add to queue"), icon: .queue, offline: true) { ctx.player.addToQueue(tracks) },
            MenuItem(L("Go to radio"), icon: .radio) { Task { await ctx.player.startRadio(seedId: id, context: id) } },
        ]
        if !tracks.isEmpty {
            var sub: [MenuItem] = [MenuItem(L("New playlist"), icon: .plus) { nameDialog = menus.newPlaylistDialog(seed: tracks.first) }]
            sub += ctx.store.playlists.filter { $0.id != id }.map { other in
                MenuItem(other.name) { Task { await ctx.store.add(tracks.map(\.id), to: other) } }
            }
            items.append(MenuItem(L("Add to playlist"), icon: .plus, sub: sub))
        }
        // "Download as zip" is out (DECISIONS 5).
        items += download.menuItems
        items.append(.separator)
        // TODO(lead): "Regenerate" for AI playlists needs the Generate dialog (UI.md 6.4).
        items.append(MenuItem(L("Edit details"), icon: .edit) { openEdit() })
        items.append(MenuItem(L("Delete"), icon: .trash, danger: true) {
            confirm = ConfirmDialog(message: L("Delete \"{name}\"?", ["name": title]), confirm: L("Delete"), destructive: true) {
                guard let p else { return }
                Task { if await ctx.store.deletePlaylist(p) { dismiss() } }
            }
        })
        let header = MenuHeader(art: .cover(.playlist(id: id, cover: p?.cover)), title: title, subtitle: L("Playlist"))
        return MenuSheet(header: header, items: ctx.offline ? MenuItem.offlineSubset(items) : items)
    }

    private var download: OfflineCollectionActions {
        OfflineCollectionActions(store: offline, id: id, name: name ?? "", kind: .playlist, tracks: tracks) { confirm = $0 }
    }

    private func openEdit() {
        guard playlist != nil else { return }
        editing = LibraryEditDetails(id: id, cover: playlist?.cover, name: name ?? "")
    }

    /// "Edit details" from Your Library: open the dialog 300 ms after the page (App.jsx:1658).
    private func openPendingEdit() {
        guard store.pendingEditDetails == id else { return }
        store.pendingEditDetails = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { openEdit() }
    }
}

/// A playlist row with a key that survives moves (the same song can be in a list twice).
struct LibraryPlaylistEntry: Identifiable, Hashable {
    let key = UUID()
    var track: Track
    var id: UUID { key }
}
