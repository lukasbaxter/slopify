import SwiftUI

/// The Search tab root (UI.md 6.2): header row, sticky white field with Cancel and the type
/// chips, then Browse tiles, Recent searches, the flat result list or the Everywhere list.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme
    @Environment(\.scenePhase) private var phase

    @State private var model = SearchModel(backend: .idle)
    @State private var browse = SearchBrowseData()
    @State private var menu: MenuSheet?
    @State private var nameDialog: NameDialog?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if !model.focusMode { header }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Section {
                            content
                        } header: {
                            searchBar
                        }
                    }
                    .id(Self.topAnchor)
                    .shellContentPadding()
                }
                .scrollIndicators(.hidden)
                .scrollDismissesKeyboard(.immediately)
                .onChange(of: nav.scrollToTop[.search]) { _, _ in
                    withAnimation { proxy.scrollTo(Self.topAnchor, anchor: .top) }
                }
            }
        }
        .background(theme.bgBase.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .contextMenuSheet($menu)
        .nameDialog($nameDialog)
        .onAppear { model.backend = .live(account.api, offline: app.offline) }
        .task(id: SearchBrowseData.storageKey(account: account)) {
            browse.use(key: SearchBrowseData.storageKey(account: account))
            await browse.refresh(api: account.api)
        }
        .onChange(of: fieldFocused) { _, f in if f { model.focused = true } }
        .onChange(of: nav.tab) { _, t in
            if t != .search { model.leftTab(); fieldFocused = false }
        }
        .onChange(of: phase) { _, p in model.hidden = p != .active }
    }

    private static let topAnchor = "search-top"

    // MARK: header + bar

    /// Not focused: avatar + "Search" (UI.md 6.2.2). Focused: folded away.
    private var header: some View {
        HStack(spacing: 12) {
            Button { nav.drawerOpen = true } label: {
                Avatar(userId: account.user?.id, name: account.user?.name, size: 32)
            }
            .buttonStyle(.pressFade)
            Text(L("Search")).textStyle(.pageTitle).foregroundStyle(theme.fg).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.gutter)
        .frame(height: Shell.header)
    }

    private var searchBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                field
                if model.focusMode {
                    Button {
                        model.cancel(); fieldFocused = false
                    } label: {
                        Text(L("Cancel")).font(.system(size: 16)).foregroundStyle(theme.fg)
                            .padding(.leading, 4).frame(height: 44)
                    }
                    .buttonStyle(.pressFade)
                    .transition(.opacity.combined(with: .offset(x: 8)))
                }
            }
            .animation(.easeOut(duration: 0.2), value: model.focusMode)
            if model.showsChips { chips }
        }
        .padding(.top, model.focusMode ? 8 : 4)
        .padding(.horizontal, Spacing.gutter)
        .padding(.bottom, 8)
        .background(theme.bgBase)
    }

    private var field: some View {
        ZStack(alignment: .leading) {
            TextField("", text: Binding(get: { model.query }, set: { model.setQuery($0) }),
                      prompt: Text(L("What do you want to listen to?")).foregroundStyle(Theme.Fixed.searchFieldPlaceholder))
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(Theme.Fixed.searchFieldText)
                .tint(Theme.Fixed.searchFieldText)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .focused($fieldFocused)
                .padding(.leading, 48).padding(.trailing, 16)
            IconView(.searchTab, size: 24).foregroundStyle(Theme.Fixed.searchFieldText)
                .padding(.leading, 12)
                .allowsHitTesting(false)
        }
        .frame(height: 44)
        .frame(maxWidth: .infinity)
        .background(Theme.Fixed.searchFieldBackground, in: RoundedRectangle(cornerRadius: Radius.art))
        .contentShape(Rectangle())
        .onTapGesture { fieldFocused = true }
    }

    private var chips: some View {
        ScrollViewReader { proxy in
            ChipRow {
                ForEach(SearchType.allCases, id: \.self) { ty in
                    Chip(L(ty.rawValue), on: model.type == ty) {
                        model.setType(ty)
                        withAnimation { proxy.scrollTo(ty) }
                    }
                    .id(ty)
                }
            }
        }
        .padding(.horizontal, -Spacing.gutter)
    }

    // MARK: body

    @ViewBuilder private var content: some View {
        let empty = model.trimmed.isEmpty
        VStack(alignment: .leading, spacing: 0) {
            if let err = model.error {
                ErrorBanner(message: err) { model.clearError() }.pageBanner()
            }
            if empty && model.focusMode && !recents.isEmpty { recentSection }
            if empty && !model.focusMode { browseSections }
            if model.type == .everywhere && !empty { everywhereSection }
            if let rows = model.rows {
                if rows.isEmpty { noResults } else { resultList(rows) }
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 24)
    }

    // MARK: browse

    @ViewBuilder private var browseSections: some View {
        SectionHeader(L("Start browsing"), style: .search, first: true)
        tileGrid {
            SearchBrowseTile(title: L("Made For You"), color: Theme.Fixed.madeForYouTile, action: { nav.select(.home) }) {
                if let id = browse.madeForYouCover { CoverImage(.artist(id: id, image: nil), size: 100, placeholder: .none) }
            }
            SearchBrowseTile(title: L("New Releases"), color: Theme.Fixed.newReleasesTile, action: { nav.push(.seeAll(.albums)) }) {
                if let id = browse.newReleasesCover { CoverImage(.album(id: id, art: nil), size: 100, placeholder: .none) }
            }
            SearchBrowseTile(title: L("Charts"), color: Theme.Fixed.radarHero, action: { nav.push(.charts) }) {
                if let id = browse.chartsCover { CoverImage(.album(id: id, art: nil), size: 100, placeholder: .none) }
            }
            SearchBrowseTile(title: L("Liked Songs"), color: Theme.Fixed.likedHero, action: { nav.push(.likedSongs) }) {
                LikedCover(heart: 0.5)
            }
        }
        SectionHeader(L("Browse all"), style: .search)
        if let tiles = browse.tiles {
            tileGrid {
                ForEach(Array(tiles.enumerated()), id: \.element.id) { i, t in
                    SearchBrowseTile(title: t.name, color: SearchLogic.tileColor(i), action: { nav.push(.genre(name: t.name)) }) {
                        if let c = t.coverId { CoverImage(.album(id: c, art: t.cover), size: 100, placeholder: .none) }
                    }
                }
            }
        }
    }

    private func tileGrid<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12, content: c)
            .padding(.horizontal, Spacing.gutter)
    }

    // MARK: recent searches

    private var recents: [SearchRecent] { SearchRecent.list(account.pref("recentSearches")) }

    private func saveRecents(_ list: [SearchRecent]) {
        Task { await account.patchPrefs(["recentSearches": SearchRecent.json(list)]) }
    }

    private func remember(_ item: SearchItem) {
        saveRecents(SearchRecent.adding(SearchRecent(query: model.query, item: item), to: recents))
    }

    @ViewBuilder private var recentSection: some View {
        SectionHeader(L("Recent searches"), style: .search, first: true)
        ForEach(recents, id: \.key) { x in
            SearchRow(source: Self.source(x), round: x.kind == .artist, name: x.name, sub: x.subtitle,
                      onTap: { openRecent(x) }, onRemove: { saveRecents(SearchRecent.removing(x, from: recents)) })
                .padding(.horizontal, Spacing.gutter)
        }
        Button { saveRecents([]) } label: {
            Text(L("Clear recent searches")).font(.system(size: 14, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.horizontal, 16).frame(minHeight: 32)
                .overlay(Capsule().strokeBorder(theme.fgFaint, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
        .frame(maxWidth: .infinity)
        .padding(.top, 16)
    }

    /// `imageUrl(art || id)`: the album for songs, the item itself otherwise.
    static func source(_ x: SearchRecent) -> CoverSource {
        let id = x.art ?? x.id
        switch x.kind {
        case .artist: return .artist(id: id, image: nil)
        case .playlist: return .playlist(id: id, cover: nil)
        case .album, .song: return .album(id: id, art: nil)
        }
    }

    private func openRecent(_ x: SearchRecent) {
        switch x.kind {
        case .song:
            if let art = x.art, art != x.id { nav.push(.album(id: art)) }
            else {
                Task {
                    do { let t = try await account.api.track(x.id); if !t.albumId.isEmpty { nav.push(.album(id: t.albumId)) } }
                    catch { ToastCenter.shared.show(error.localizedDescription) }
                }
            }
        case .artist: nav.push(.artist(id: x.id))
        case .playlist: nav.push(.playlist(id: x.id))
        case .album: nav.push(.album(id: x.id))
        }
        saveRecents(SearchRecent.adding(x, to: recents))
    }

    // MARK: results

    private func resultList(_ rows: [SearchItem]) -> some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(rows, id: \.key) { item in
                switch item {
                case .song(let t):
                    TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id,
                             isDownloaded: app.offline.has(t.id), isUnavailable: app.offline.unavailable(t.id),
                             subtitle: SearchItem.songSubtitle(t),
                             onTap: { tapSong(t) },
                             onMore: { menu = TrackMenuBuilder(app: app) { nameDialog = $0 }.sheet(t) },
                             onArt: { open(item) },
                             onTouchDown: { player.prewarm(t) })
                default:
                    SearchRow(source: Self.source(item), round: item.kind == .artist, name: item.name, sub: item.subtitle,
                              onTap: { open(item) })
                        .padding(.horizontal, Spacing.gutter)
                }
            }
        }
        .padding(.top, 4)
    }

    static func source(_ item: SearchItem) -> CoverSource {
        switch item {
        case .song(let t): CoverSource(t)
        case .artist(let a): CoverSource(a)
        case .album(let a): CoverSource(a)
        case .playlist(let p): CoverSource(p)
        }
    }

    /// The playing song toggles; any other opens its album (DECISIONS 4).
    private func tapSong(_ t: Track) {
        if player.current?.id == t.id { player.togglePlay() } else { open(.song(t)) }
    }

    private func open(_ item: SearchItem) {
        remember(item)
        switch item {
        case .song(let t): if !t.albumId.isEmpty { nav.push(.album(id: t.albumId)) }
        case .artist(let a): nav.push(.artist(id: a.id))
        case .album(let a): nav.push(.album(id: a.id))
        case .playlist(let p): nav.push(.playlist(id: p.id))
        }
    }

    private var noResults: some View {
        emptyBlock(L("Couldn’t find “{query}”", ["query": model.trimmed]), L("Try searching again using a different spelling or keyword."))
    }

    private func emptyBlock(_ title: String, _ hint: String) -> some View {
        VStack(spacing: 8) {
            Text(title).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
            Text(hint).font(.system(size: 13)).foregroundStyle(theme.fgSub)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 96)
        .padding(.horizontal, 24)
    }

    // MARK: everywhere

    @ViewBuilder private var everywhereSection: some View {
        switch model.everywhere {
        case nil, .waiting?: note(L("Searching everywhere…"))
        case .failed?: note(L("Couldn’t search everywhere right now."))
        case .loaded(let r)?:
            if r.albums.isEmpty {
                emptyBlock(L("Couldn’t find “{query}” anywhere", ["query": model.trimmed]), L("Try a different spelling, or the artist and album together."))
            } else {
                HStack(alignment: .firstTextBaseline) {
                    Text(L("Everywhere")).textStyle(.sectionSearch).foregroundStyle(theme.fg)
                    Spacer(minLength: 8)
                    Text(L("{have} of {total} in your library", ["have": r.albums.filter { $0.inLibrary != nil }.count, "total": r.albums.count]))
                        .font(.system(size: 13)).foregroundStyle(theme.fgSub)
                }
                .padding(.top, 12).padding(.bottom, 4)
                .padding(.horizontal, Spacing.gutter)
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(r.albums.enumerated()), id: \.offset) { _, a in releaseRow(a) }
                }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(theme.fgSub)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24 + 8)
    }

    private func releaseRow(_ a: Release) -> some View {
        let sub = [a.rtype.map { L($0) } ?? "", a.year ?? "", a.artist ?? ""].filter { !$0.isEmpty }.joined(separator: " • ")
        let src: CoverSource = a.inLibrary.map { .album(id: $0, art: nil) } ?? .url(a.image.flatMap(URL.init(string:)))
        return SearchRow(source: src, name: a.title, sub: sub, missing: a.inLibrary == nil, onTap: { openOrRequest(a) }) {
            // In-library rows: the web's play button renders invisible on phone, so it is left out.
            if a.inLibrary == nil { requestButton(a) }
        }
        .padding(.horizontal, Spacing.gutter)
    }

    private func requestButton(_ a: Release) -> some View {
        let ui = SearchRequestState.ui(model.state(of: a))
        return Button { Task { await model.request(a) } } label: {
            Text(ui.label).font(.system(size: 12, weight: .bold))
                .foregroundStyle(ui.busy ? theme.fg : Theme.Fixed.searchFieldText)
                .padding(.vertical, 6).padding(.horizontal, 12)
                .background(ui.busy ? theme.tintPress : Theme.Fixed.searchFieldBackground, in: Capsule())
        }
        .buttonStyle(.pressFade)
        .disabled(ui.busy)
        .padding(.leading, 4)
        .accessibilityHint(L("Download this release into your library"))
    }

    private func openOrRequest(_ a: Release) {
        if let id = a.inLibrary { nav.push(.album(id: id)) }
        else if model.state(of: a) == nil { Task { await model.request(a) } }
    }
}
