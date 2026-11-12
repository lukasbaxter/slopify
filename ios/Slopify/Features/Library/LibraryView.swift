import SwiftUI
import PhotosUI

/// "Your Library" (UI.md 5.2, Sidebar.jsx on the phone): header with find / create, filter
/// chips, the static "Recents" sort row with the grid/list toggle, then the list. Tree mode
/// (no filter, query or offline) shows folders and lets rows be dragged into a new order.
struct LibraryView: View {
    @Environment(Navigator.self) private var nav
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(SessionClient.self) private var session
    @Environment(OfflineStore.self) private var offlineStore
    @Environment(\.theme) private var theme

    @State private var store = LibraryStore.shared
    @State private var filter: LibraryFilter?
    @State private var searching = false
    @State private var query = ""
    /// In memory only (UI.md 5.2.4): survives tab switches, not relaunches.
    @State private var grid = false
    @State private var openFolders = LibraryOpenFolders.load()
    /// While a folder is dragged every folder shows shut.
    @State private var shut = false
    @State private var settled = false
    @State private var menu: MenuSheet?
    @State private var naming: LibraryNaming?
    @State private var confirm: ConfirmDialog?
    @State private var drag = LibraryDragController()
    @State private var gridFrames: [String: CGRect] = [:]
    @State private var listWidth: CGFloat = 0
    @State private var photoFolder: String?
    @State private var photoItem: PhotosPickerItem?
    @FocusState private var findFocused: Bool

    private let contentSpace = "lib-content"
    private let topId = "lib-top"

    private var ctx: LibraryContext { LibraryContext(api: account.api, account: account, player: player, likes: likes, nav: nav, session: session) }

    var body: some View {
        let offline = ctx.offline
        let arrangement = store.arrangement(pinned: ctx.pinned)
        let flat = LibraryArrangement.isFlat(filter: filter, query: query, offline: offline)
        let downloaded = offlineStore.heldCollections
        let shown = arrangement.shown(filter: filter, query: query, offline: offline, downloaded: downloaded, openFolders: openFolders, shut: shut)
        let showLiked = LibraryArrangement.showLiked(filter: filter, query: query, likedName: L("Liked Songs"), offline: offline, likedDownloaded: downloaded.contains(LibraryRowModel.likedId))
        VStack(spacing: 0) {
            header
            chips(offline: offline)
            if searching { findRow } else { sortRow }
            list(arrangement: arrangement, shown: shown, showLiked: showLiked, flat: flat, offline: offline)
        }
        .background(theme.bgBase.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .contextMenuSheet($menu)
        .overlayCover(item: $naming) { n, close in
            LibraryNamingPage(naming: n, close: close) { n, name in submitNaming(n, name, arrangement: arrangement) }
        }
        .confirmDialog($confirm)
        .photosPicker(isPresented: Binding(get: { photoFolder != nil }, set: { if !$0 && photoItem == nil { photoFolder = nil } }),
                      selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in uploadFolderPhoto(item) }
        .onChange(of: offline) { _, off in if off && filter == .artist { filter = nil } }
        .onChange(of: nav.scrollToTop[.library]) { _, _ in scrollTopRequest += 1 }
        .task {
            ctx.attachStore()
            await store.refresh()
        }
        .task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            settled = true
        }
    }

    @State private var scrollTopRequest = 0

    // MARK: - Header (5.1, 5.2.2)

    private var header: some View {
        HStack(spacing: 12) {
            Button { nav.drawerOpen = true } label: {
                Avatar(userId: account.user?.id, name: account.user?.name, size: 32)
            }
            .buttonStyle(.pressFade)
            Text(L("Your Library")).textStyle(.pageTitle).foregroundStyle(theme.fg).lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 4) {
                headerButton(.libSearch, label: L("Find in Your Library"), on: searching) {
                    searching.toggle(); query = ""
                    if searching { DispatchQueue.main.async { findFocused = true } }
                }
                headerButton(.libPlus, label: L("Create playlist"), on: false) { openCreate() }
            }
            .padding(.trailing, 8 - Spacing.gutter)
        }
        .padding(.horizontal, Spacing.gutter)
        .frame(minHeight: Shell.header)
    }

    /// 40x40, 24 pt glyph `--fg`; green `--accent-ink` while on.
    private func headerButton(_ icon: Icon, label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            IconView(icon, size: 24).foregroundStyle(on ? theme.accentInk : theme.fg).frame(width: 40, height: 40).contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
        .accessibilityLabel(label)
    }

    // MARK: - Chips (5.2.3)

    private func chips(offline: Bool) -> some View {
        ChipRow {
            if filter != nil {
                Button { filter = nil } label: {
                    Text(verbatim: "×").font(.system(size: 18)).foregroundStyle(theme.fg)
                        .frame(width: 32, height: 32).background(theme.chip, in: Circle())
                }
                .buttonStyle(.pressFade)
                .accessibilityLabel(L("Clear filter"))
            }
            ForEach(LibraryFilter.allCases.filter { !(offline && $0 == .artist) }, id: \.self) { f in
                if filter == nil || filter == f {
                    Chip(label(f), on: filter == f, small: true) { filter = filter == f ? nil : f }
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func label(_ f: LibraryFilter) -> String {
        switch f { case .playlist: L("Playlists"); case .album: L("Albums"); case .artist: L("Artists") }
    }

    // MARK: - Sort row (5.2.4) / find row (5.2.5)

    private var sortRow: some View {
        HStack(spacing: 6) {
            IconView(.sort, size: 16)
            Text(L("Recents")).font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
            Button { grid.toggle() } label: {
                IconView(grid ? .list : .grid, size: 20).frame(width: 40, height: 40).contentShape(Circle())
            }
            .buttonStyle(.pressFade)
            .padding(.trailing, -10)
            .accessibilityLabel(grid ? L("List view") : L("Grid view"))
        }
        .foregroundStyle(theme.fg)
        .frame(minHeight: 40)
        .padding(.horizontal, Spacing.gutter)
        .padding(.vertical, 8)
    }

    private var findRow: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                IconView(.libSearch, size: 20).foregroundStyle(theme.fgSub)
                TextField("", text: $query, prompt: Text(L("Find in Your Library")).foregroundStyle(theme.fgSub))
                    .font(.system(size: 16)).foregroundStyle(theme.fg)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .focused($findFocused)
            }
            .padding(.leading, 10).padding(.trailing, 12)
            .frame(height: 36)
            .background(theme.chip, in: RoundedRectangle(cornerRadius: Radius.art))
            Button { searching = false; query = "" } label: {
                Text(L("Cancel")).font(.system(size: 14, weight: .semibold)).foregroundStyle(theme.fg)
                    .padding(.horizontal, 4).frame(height: 36)
            }
            .buttonStyle(.pressFade)
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, 4).padding(.bottom, 8)
    }

    // MARK: - List (5.2.6 - 5.2.13)

    private func rowModel(_ e: LibraryEntry, arrangement a: LibraryArrangement, pinned: Set<String>) -> LibraryRowModel {
        let held = e.kind == .artist || e.kind == .folder ? nil : offlineStore.summary(e.id)
        return LibraryRowModel(entry: e, subtitle: LibraryText.subtitle(e, folderCount: a.kids[e.id]?.count ?? 0),
                               pinned: e.kind != .folder && pinned.contains(e.id),
                               downloaded: Self.fullyHeld(held), partial: partialText(held),
                               folderOpen: e.kind == .folder && openFolders.contains(e.id) && !shut)
    }

    private var likedModel: LibraryRowModel {
        let held = offlineStore.summary(OfflineIndex.likedId)
        return LibraryRowModel(entry: nil, subtitle: LibraryText.likedSubtitle(count: likedCountKnown ? likes.tracks.count : nil), pinned: true,
                               downloaded: Self.fullyHeld(held), partial: partialText(held))
    }

    /// Sidebar.jsx:148-156: the mark once every song is here; offline, partial shows as text.
    private static func fullyHeld(_ h: OfflineSummary?) -> Bool { h.map { $0.total > 0 && $0.have >= $0.total } ?? false }

    private func partialText(_ h: OfflineSummary?) -> String? {
        guard ctx.offline, let h, h.have > 0, h.have < h.total else { return nil }
        return L("{have} of {total} downloaded", ["have": h.have, "total": h.total]) + " • "
    }

    private var likedCountKnown: Bool { !likes.tracks.isEmpty || !store.loading }

    @ViewBuilder
    private func list(arrangement a: LibraryArrangement, shown: [LibraryEntry], showLiked: Bool, flat: Bool, offline: Bool) -> some View {
        let pinned = Set(ctx.pinned)
        let models = shown.map { rowModel($0, arrangement: a, pinned: pinned) }
        let empty = LibraryEmptyState.pick(offline: offline, showLiked: showLiked, shownCount: shown.count, query: query, filter: filter,
                                           loading: store.loading, settled: settled, likedCountKnown: likedCountKnown)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Color.clear.frame(height: 0).id(topId)
                    if grid {
                        gridBody(models: models, showLiked: showLiked, flat: flat, arrangement: a, shown: shown)
                    } else {
                        listBody(models: models, showLiked: showLiked, flat: flat, arrangement: a, shown: shown)
                    }
                    if let empty { emptyBlock(empty) }
                }
                .padding(.horizontal, Spacing.gutter)
                .coordinateSpace(name: contentSpace)
                .overlay(alignment: .topLeading) { dropLine }
                .background(GeometryReader { g in
                    Color.clear.onAppear { listWidth = g.size.width }.onChange(of: g.size.width) { _, w in listWidth = w }
                })
                // The drag's one recognizer lives on this scroll view; points are in this view's space.
                .background(LibraryDragProbe(drag: drag))
                .shellContentPadding()
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.immediately)
            .refreshable { await store.refresh() }
            .onAppear { wireDrag() }
            .onChange(of: scrollTopRequest) { _, _ in withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(topId, anchor: .top) } }
        }
    }

    @ViewBuilder
    private func listBody(models: [LibraryRowModel], showLiked: Bool, flat: Bool, arrangement a: LibraryArrangement, shown: [LibraryEntry]) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if showLiked { likedRow { LibraryListRow(model: likedModel) } }
            ForEach(models) { m in
                row(m, flat: flat, arrangement: a, shown: shown, showLiked: showLiked) { LibraryListRow(model: m) }
            }
        }
    }

    @ViewBuilder
    private func gridBody(models: [LibraryRowModel], showLiked: Bool, flat: Bool, arrangement a: LibraryArrangement, shown: [LibraryEntry]) -> some View {
        // Not lazy: a drag measures every cell at the lift.
        let cells: [LibraryRowModel?] = (showLiked ? [nil] : []) + models.map { Optional($0) }
        let pairs = stride(from: 0, to: cells.count, by: 2).map { Array(cells[$0..<min($0 + 2, cells.count)]) }
        VStack(alignment: .leading, spacing: LibraryLayoutMetrics.gridGap) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { _, pair in
                HStack(alignment: .top, spacing: LibraryLayoutMetrics.gridGap) {
                    ForEach(0..<2, id: \.self) { i in
                        if i < pair.count {
                            if let m = pair[i] {
                                row(m, flat: flat, arrangement: a, shown: shown, showLiked: showLiked) { LibraryGridCell(model: m) }
                                    .frame(maxWidth: .infinity)
                                    .background(GeometryReader { g in
                                        Color.clear.preference(key: LibraryFramesKey.self, value: [m.id: g.frame(in: .named(contentSpace))])
                                    })
                            } else {
                                likedRow { LibraryGridCell(model: likedModel) }.frame(maxWidth: .infinity)
                            }
                        } else {
                            Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                        }
                    }
                }
            }
        }
        .padding(.top, 8)
        .onPreferenceChange(LibraryFramesKey.self) { gridFrames = $0 }
    }

    /// Liked Songs: always first, never dragged; long-press opens its menu in both modes (DECISIONS).
    private func likedRow<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content()
            .pressable(.row, onTap: { nav.push(.likedSongs) }, onLongPress: { menu = likedMenu() })
    }

    @ViewBuilder
    private func row<C: View>(_ m: LibraryRowModel, flat: Bool, arrangement a: LibraryArrangement, shown: [LibraryEntry], showLiked: Bool,
                              @ViewBuilder content: () -> C) -> some View {
        let e = m.entry!
        let lifted = drag.lift?.id == e.id
        let target = drag.targetFolder == e.id
        if flat {
            content().pressable(.row, onTap: { open(e) }, onLongPress: { menu = entryMenu(e, arrangement: a) })
        } else {
            content()
                .background { if target { theme.fg(0.14).overlay(Rectangle().strokeBorder(theme.accentInk, lineWidth: 2)) } }
                .background { if lifted { theme.cardHover.shadow(color: .black.opacity(0.45), radius: 12, y: 8) } }
                // Tap opens; the 380 ms hold (drag or menu) is the scroll view's recognizer.
                .pressable(.row, onTap: { open(e) })
                .scaleEffect(lifted ? 1.02 : 1)
                .offset(drag.offset(for: e.id))
                .zIndex(lifted ? 1 : 0)
                .animation(lifted ? nil : .timingCurve(0.2, 0, 0, 1, duration: 0.18), value: drag.lift?.target)
        }
    }

    @ViewBuilder
    private var dropLine: some View {
        if let r = drag.dropLine {
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 1).fill(theme.accentInk).frame(width: r.width, height: 2)
                Circle().fill(theme.page).overlay(Circle().strokeBorder(theme.accentInk, lineWidth: 2))
                    .frame(width: 8, height: 8).offset(x: -4)
            }
            .offset(x: r.minX, y: r.minY)
            .allowsHitTesting(false)
            .transition(.opacity)
        }
    }

    // MARK: - Drag

    /// Tree mode only: the rows, folders shutting for a folder drag, and what a drop or hold does.
    private func wireDrag() {
        drag.rows = { currentRows() }
        drag.canEnter = { [store] id in store.arrangement(pinned: []).byId[id]?.kind != .folder }
        drag.willLift = { id in
            guard store.arrangement(pinned: []).byId[id]?.kind == .folder, !openFolders.isEmpty, !shut else { return false }
            shut = true
            return true
        }
        drag.coveredBottom = Shell.contentBottom - 24
        drag.onFinish = { finishDrag($0) }
    }

    /// Drag rows in content coordinates. The list has fixed 80 pt rows; the grid is measured.
    private func currentRows() -> [LibraryDrag.Row] {
        let offline = ctx.offline
        guard !LibraryArrangement.isFlat(filter: filter, query: query, offline: offline) else { return [] }
        let showLiked = LibraryArrangement.showLiked(filter: filter, query: query, likedName: L("Liked Songs"), offline: offline,
                                                     likedDownloaded: offlineStore.heldCollections.contains(LibraryRowModel.likedId))
        let a = store.arrangement(pinned: ctx.pinned)
        let shown = a.shown(filter: filter, query: query, offline: ctx.offline, downloaded: offlineStore.heldCollections, openFolders: openFolders, shut: shut)
        if grid {
            return shown.compactMap { e in gridFrames[e.id].map { LibraryDrag.Row(id: e.id, folder: e.kind == .folder, rect: $0) } }
        }
        let width = max(0, listWidth - 2 * Spacing.gutter)
        let y0: CGFloat = showLiked ? LibraryLayoutMetrics.listRow : 0
        return shown.enumerated().map { i, e in
            LibraryDrag.Row(id: e.id, folder: e.kind == .folder,
                            rect: CGRect(x: Spacing.gutter, y: y0 + CGFloat(i) * LibraryLayoutMetrics.listRow, width: width, height: LibraryLayoutMetrics.listRow))
        }
    }

    private func finishDrag(_ outcome: LibraryDragController.Outcome?) {
        // Use the arrangement as it is now (folders may have shut for the drag).
        let a = store.arrangement(pinned: ctx.pinned)
        let shown = a.shown(filter: filter, query: query, offline: ctx.offline, downloaded: offlineStore.heldCollections, openFolders: openFolders, shut: shut)
        switch outcome {
        case .hold(let id):
            shut = false
            if let e = a.byId[id] { menu = entryMenu(e, arrangement: a) }
        case let .drop(id, to, into, rows):
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) {
                let d = a.dropping(a.draft(layout: store.layout), id: id, to: to, into: into, rows: rows, shown: shown, openFolders: openFolders, shut: shut)
                shut = false
                store.saveArrangement(d)
            }
        case nil:
            withAnimation(.timingCurve(0.2, 0, 0, 1, duration: 0.2)) { shut = false }
        }
    }

    // MARK: - Taps and menus (5.2.9)

    private func open(_ e: LibraryEntry) {
        switch e.kind {
        case .playlist: nav.push(.playlist(id: e.id))
        case .album: nav.push(.album(id: e.id))
        case .artist: nav.push(.artist(id: e.id))
        case .folder:
            if openFolders.contains(e.id) { openFolders.remove(e.id) } else { openFolders.insert(e.id) }
            LibraryOpenFolders.save(openFolders)
        }
    }

    private func likedMenu() -> MenuSheet {
        let ctx = ctx
        return MenuSheet(items: [
            MenuItem(L("Add to queue")) { Task { if let t = await likedTracks(ctx) { ctx.player.addToQueue(t) } } },
            MenuItem(L("Play")) { Task { if let t = await likedTracks(ctx), !t.isEmpty { ctx.player.play(t, startAt: 0, context: "liked") } } },
        ])
    }

    private func likedTracks(_ ctx: LibraryContext) async -> [Track]? {
        try? await ctx.api.likes(full: true).items
    }

    /// The tracks of a library entry (Sidebar.jsx `playEntry`): album songs, artist mix, playlist songs.
    private static func tracks(of e: LibraryEntry, ctx: LibraryContext) async -> [Track] {
        switch e.kind {
        case .album: return (try? await ctx.api.album(e.id).tracks) ?? []
        case .artist:
            let mix = (try? await ctx.api.mix(e.id, limit: 100, mode: "radio").items) ?? []
            return StreamPolicy.dropDisliked(mix, prefs: ctx.account.prefs)
        case .playlist: return (try? await ctx.api.playlist(e.id).tracks) ?? []
        case .folder: return []
        }
    }

    private func entryMenu(_ e: LibraryEntry, arrangement a: LibraryArrangement) -> MenuSheet {
        let ctx = ctx
        let store = store
        let pinned = ctx.pinned.contains(e.id)
        let queue = MenuItem(L("Add to queue")) { Task { let t = await Self.tracks(of: e, ctx: ctx); if !t.isEmpty { ctx.player.addToQueue(t) } } }
        let play = MenuItem(L("Play")) { Task { let t = await Self.tracks(of: e, ctx: ctx); if !t.isEmpty { ctx.player.play(t, startAt: 0, context: e.id) } } }
        switch e.kind {
        case .folder:
            return MenuSheet(items: [
                MenuItem(L("Rename"), icon: .edit) { naming = LibraryNaming(kind: .rename(id: e.id), name: e.name) },
                MenuItem(L("Choose photo"), icon: .photo) { photoItem = nil; photoFolder = e.id },
                MenuItem(L("Delete"), icon: .trash, danger: true) {
                    confirm = ConfirmDialog(message: L("Delete \"{name}\"?", ["name": e.name]), confirm: L("Delete"), destructive: true) {
                        store.deleteFolder(e.id, arrangement: store.arrangement(pinned: ctx.pinned))
                    }
                },
            ])
        case .album:
            var items = [queue, play, .separator,
                         MenuItem(pinned ? L("Unpin album") : L("Pin album")) { ctx.togglePin(e.id) }]
            if let artistId = e.album?.artistId { items.append(MenuItem(L("Go to artist")) { ctx.nav.push(.artist(id: artistId)) }) }
            items.append(MenuItem(L("Share")) { ctx.share(kind: .album, id: e.id, title: e.name, by: e.album?.artist) })
            items.append(MenuItem(L("Remove from Your Library")) {
                Task {
                    await ctx.likes.toggle(e.id, kind: .album)
                    await store.refreshAlbums()
                    ToastCenter.shared.show(L("Removed from Your Library"))
                }
            })
            return MenuSheet(items: items)
        case .artist:
            return MenuSheet(items: [queue, play, .separator,
                MenuItem(pinned ? L("Unpin artist") : L("Pin artist")) { ctx.togglePin(e.id) },
                MenuItem(L("Share")) { ctx.share(kind: .artist, id: e.id, title: e.name, by: nil) },
                MenuItem(L("Unfollow")) {
                    Task {
                        if ctx.likes.isLiked(e.id) { await ctx.likes.toggle(e.id, kind: .artist) } else { try? await ctx.api.unlike(e.id) }
                        await store.refreshArtists()
                        store.onLibraryChanged?()
                    }
                },
            ])
        case .playlist:
            // TODO(lead): "Regenerate" (AI playlists) needs the Generate dialog (UI.md 6.4); left out until it exists.
            return MenuSheet(items: [queue, play, .separator,
                MenuItem(pinned ? L("Unpin playlist") : L("Pin playlist")) { ctx.togglePin(e.id) },
                MenuItem(L("Edit details")) {
                    store.pendingEditDetails = e.id
                    ctx.nav.push(.playlist(id: e.id))
                },
                MenuItem(L("Delete"), icon: .trash, danger: true) {
                    confirm = ConfirmDialog(message: L("Delete \"{name}\"?", ["name": e.name]), confirm: L("Delete"), destructive: true) {
                        if let p = e.playlist { Task { _ = await store.deletePlaylist(p) } }
                    }
                },
            ])
        }
    }

    // MARK: - Create (5.2.10)

    private func openCreate() {
        // TODO(lead): "Generated playlist (AI)" opens the Generate dialog (UI.md 6.4); left out until it exists.
        menu = MenuSheet(items: [
            MenuItem(L("Playlist"), icon: .playlist) { naming = LibraryNaming(kind: .playlist) },
            MenuItem(L("Folder"), icon: .folder) { naming = LibraryNaming(kind: .folder) },
        ])
    }

    private func submitNaming(_ n: LibraryNaming, _ name: String, arrangement _: LibraryArrangement) {
        let a = store.arrangement(pinned: ctx.pinned)
        switch n.kind {
        case .playlist: Task { await store.createPlaylist(name: name) }
        case .folder: store.createFolder(name, arrangement: a)
        case .rename(let id): if a.byId[id]?.name != name { store.renameFolder(id, name: name, arrangement: a) }
        }
    }

    private func uploadFolderPhoto(_ item: PhotosPickerItem?) {
        guard let item, let id = photoFolder else { return }
        photoFolder = nil
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) else { return }
            store.setFolderCover(id, jpeg: jpeg)
            photoItem = nil
        }
    }

    // MARK: - Empty states (5.2.13)

    private func emptyBlock(_ s: LibraryEmptyState) -> some View {
        let (title, line, button): (String, String, Bool) = {
            switch s {
            case .nothingDownloaded: (L("Nothing downloaded"), L("Download a playlist or album while you have a connection and it shows here."), false)
            case .createFirst: (L("Create your first playlist"), L("It's easy, we'll help you."), true)
            case .noMatch(let q): (L("Couldn’t find “{query}”", ["query": q]), L("Try a different playlist, album or artist name."), false)
            case .noArtists: (L("No artists yet"), L("Follow an artist and they show up here."), false)
            case .noAlbums: (L("Save your first album"), L("Add an album to Your Library and it shows up here."), false)
            }
        }()
        return VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
            Text(line).font(.system(size: 13)).foregroundStyle(theme.fgSub).padding(.bottom, 6)
            if button {
                Button { openCreate() } label: {
                    Text(L("Create playlist")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.onFg)
                        .padding(.horizontal, 16).frame(minHeight: 32).background(theme.fg, in: Capsule())
                }
                .buttonStyle(.pressFade)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 24).padding(.bottom, 8)
    }
}

/// Open folders, per device (`slopify.libOpenFolders`, a JSON array of ids).
enum LibraryOpenFolders {
    static let key = "slopify.libOpenFolders"
    static func load(_ d: UserDefaults = .standard) -> Set<String> {
        guard let s = d.string(forKey: key), let a = try? JSONDecoder().decode([String].self, from: Data(s.utf8)) else { return [] }
        return Set(a)
    }
    static func save(_ ids: Set<String>, _ d: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(ids.sorted()), let s = String(data: data, encoding: .utf8) { d.set(s, forKey: key) }
    }
}

private struct LibraryFramesKey: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}
