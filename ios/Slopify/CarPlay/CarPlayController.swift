import CarPlay
import MediaPlayer
import Observation
import UIKit

/// Builds and keeps the CarPlay templates: a Home / Your Library tab bar (no Search tab:
/// CPSearchTemplate is not allowed for audio apps; voice search would need SiriKit
/// INPlayMediaIntent handling later), drill-in track lists, Now Playing buttons and Up Next.
///
/// Lists are rebuilt only when their data changes (home / library / likes / offline / network),
/// and only when the rows differ. Player changes just move the playing marks; the 0.5 s
/// progress tick is never observed.
@MainActor
final class CarPlayController: NSObject {
    private let ic: CPInterfaceController
    private let app: AppModel?
    private let art: CarPlayArtwork
    private var alive = true

    private let homeList = CPListTemplate(title: L("Home"), sections: [])
    private let libraryList = CPListTemplate(title: L("Your Library"), sections: [])
    private lazy var tabBar = CPTabBarTemplate(templates: [homeList, libraryList])
    private var showingTabs = false

    /// Every list built here that may still be on screen (weak templates, pruned as they go).
    private var lists: [CarPlayLiveList] = []
    private weak var queueList: CarPlayLiveList?
    private var rebuildPending = false
    /// Up Next "Next from: {name}", resolved per context.
    private var from: (ctx: String?, name: String) = (nil, NowPlayingFrom.fallback.name)

    init(interfaceController: CPInterfaceController, app: AppModel?, scale: CGFloat) {
        ic = interfaceController
        self.app = app
        art = CarPlayArtwork(scale: scale)
        super.init()
        homeList.tabTitle = L("Home")
        homeList.tabImage = UIImage(systemName: "house.fill")
        libraryList.tabTitle = L("Your Library")
        libraryList.tabImage = UIImage(systemName: "books.vertical.fill")
    }

    func start() {
        guard let app else { showSignedOut(); return }
        lists = [CarPlayLiveList(template: homeList) { [weak self] in self?.buildHome() ?? .init() },
                 CarPlayLiveList(template: libraryList) { [weak self] in self?.buildLibraryRoot() ?? .init() }]
        for l in lists { attach(l) }
        setUpNowPlaying()
        watch({ _ = app.account.state }) { [weak self] in self?.applyRoot() }
        watch({ [weak self] in self?.readData() }) { [weak self] in self?.scheduleRebuild() }
        watch({ _ = app.player.current?.id; _ = app.player.context; _ = app.player.queuedFlags }) { [weak self] in self?.playerMoved() }
        watch({ _ = app.player.shuffle; _ = app.player.repeatMode; _ = app.player.current?.id; _ = app.likes.tracks }) { [weak self] in
            self?.updateNowPlayingButtons()
        }
        applyRoot()
    }

    func stop() {
        alive = false
        CPNowPlayingTemplate.shared.remove(self)
        lists = []
    }

    // MARK: Observation

    /// Re-arms after every change; `fire` runs after the change landed (onChange is willSet).
    private func watch(_ read: @escaping @MainActor () -> Void, _ fire: @escaping @MainActor () -> Void) {
        guard alive else { return }
        withObservationTracking { read() } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.alive else { return }
                fire()
                self.watch(read, fire)
            }
        }
    }

    /// Everything a list's rows come from.
    private func readData() {
        guard let app else { return }
        _ = HomeStore.shared.data
        _ = HomeStore.shared.loadedAt
        _ = app.library.playlists; _ = app.library.albums; _ = app.library.artists
        _ = app.library.likedRows; _ = app.library.likedAt
        _ = app.likes.tracks
        _ = app.offline.index
        _ = Connectivity.shared.offline
    }

    /// Changes come in bursts (a refresh sets several lists, a download writes the index per song).
    private func scheduleRebuild() {
        guard !rebuildPending else { return }
        rebuildPending = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            guard let self, self.alive else { return }
            self.rebuildPending = false
            self.renderAll()
        }
    }

    private func renderAll() {
        lists.removeAll { $0.template == nil }
        for l in lists { render(l) }
    }

    // MARK: Root

    private func applyRoot() {
        guard let app else { return }
        if app.account.state == .signedIn {
            guard !showingTabs else { return }
            showingTabs = true
            lists.removeAll { $0.template !== homeList && $0.template !== libraryList }
            renderAll()
            ic.setRootTemplate(tabBar, animated: true, completion: nil)
            loadAfterSignIn(app)
        } else {
            showingTabs = false
            showSignedOut()
        }
    }

    private func showSignedOut() {
        let t = CPListTemplate(title: "Slopify", sections: [])
        t.emptyViewTitleVariants = [L("Log in")]
        // TODO(lead): add this key to the web locales (falls back to English until then).
        t.emptyViewSubtitleVariants = [L("Log in to Slopify on your phone to listen in the car.")]
        ic.setRootTemplate(t, animated: true, completion: nil)
    }

    /// The phone screens load these when they appear; in the car the phone UI may never show.
    private func loadAfterSignIn(_ app: AppModel) {
        HomeStore.shared.use(key: HomeStore.key(for: app.account))
        Task { await HomeStore.shared.load(api: app.account.api, maxAge: 60) }
        Task {
            await app.start()
            await app.library.refresh()
        }
    }

    // MARK: Building

    private var isOffline: Bool { Connectivity.shared.offline }
    private var held: Set<String> { app?.offline.heldCollections ?? [] }
    private var cap: Int { max(1, CPListTemplate.maximumItemCount) }

    private func buildHome() -> CarPlayBuilt {
        let store = HomeStore.shared
        let sections = CarPlayLogic.homeSections(store.data, mixSeeds: store.mixSeeds, offline: isOffline, held: held,
                                                 currentYear: Calendar.current.component(.year, from: Date()), perSection: 12)
        let empty = isOffline ? L("Offline · downloaded music only") : store.loadedAt == nil ? L("Loading…") : L("Nothing here yet.")
        return CarPlayBuilt(sections: sections, empty: empty)
    }

    private func buildLibraryRoot() -> CarPlayBuilt {
        guard let app else { return .init() }
        let liked = app.likes.loaded ? app.likes.tracks.count : (app.library.likedLoaded ? app.library.likedAt.count : nil)
        return CarPlayBuilt(sections: [.init(title: nil, rows: CarPlayLogic.libraryRoot(likedCount: liked, offline: isOffline, held: held))])
    }

    private func render(_ l: CarPlayLiveList) {
        guard let t = l.template, let api = app?.account.api else { return }
        let b = l.build()
        l.tracks = b.tracks; l.context = b.context
        t.emptyViewTitleVariants = b.empty.map { [$0] } ?? []
        guard b.sections != l.last else { return }
        l.last = b.sections
        l.items = []
        var budget = cap
        var out: [CPListSection] = []
        for s in b.sections.prefix(max(1, CPListTemplate.maximumSectionCount)) where budget > 0 {
            let rows = s.rows.prefix(budget)
            budget -= rows.count
            let items = rows.map { makeItem($0, list: l, api: api) }
            out.append(CPListSection(items: items, header: s.title, sectionIndexTitle: nil))
        }
        t.updateSections(out)
    }

    private func makeItem(_ row: CarPlayLogic.Row, list: CarPlayLiveList, api: APIClient) -> CPListItem {
        let cached = art.cached(row.art, api: api)
        let item = CPListItem(text: row.title, detailText: row.subtitle, image: cached ?? CarPlayArtwork.placeholder(row.glyph))
        switch row.target {
        case .track, .queue: item.accessoryType = .none
        default: item.accessoryType = .disclosureIndicator
        }
        item.isPlaying = mark(row)
        item.handler = { [weak self, weak list] _, done in
            MainActor.assumeIsolated { self?.tapped(row, in: list) }
            done()
        }
        if cached == nil, row.art != nil { art.load(row.art, api: api, into: item) }
        list.items.append((item, row))
        return item
    }

    private func mark(_ row: CarPlayLogic.Row) -> Bool {
        guard let p = app?.player else { return false }
        return CarPlayLogic.isPlaying(row, currentId: p.current?.id, playerContext: p.context, playerIndex: p.index)
    }

    private func attach(_ l: CarPlayLiveList) {
        lists.append(l)
        render(l)
    }

    // MARK: Taps

    private func tapped(_ row: CarPlayLogic.Row, in list: CarPlayLiveList?) {
        guard let app else { return }
        switch row.target {
        case .track(_, let i):
            guard let list, list.tracks.indices.contains(i) else { return }
            play(list.tracks, at: i, context: list.context)
        case .queue(let i):
            app.player.skip(to: i)
        default:
            open(row.target)
        }
    }

    private func play(_ tracks: [Track], at i: Int, context: String?) {
        guard let app else { return }
        let p = app.player
        if !(p.current?.id == tracks[i].id && p.context == context) {
            // Same path as the phone's rows: offline it plays downloaded songs only.
            app.offline.play(tracks, at: i, context: context, player: p)
        }
        showNowPlaying()
    }

    private func showNowPlaying() {
        let np = CPNowPlayingTemplate.shared
        if ic.topTemplate === np { return }
        if ic.templates.contains(where: { $0 === np }) { ic.pop(to: np, animated: true, completion: nil) }
        else { ic.pushTemplate(np, animated: true, completion: nil) }
    }

    private func push(_ title: String, build: @escaping @MainActor (CarPlayLiveList) -> CarPlayBuilt) -> CarPlayLiveList {
        let t = CPListTemplate(title: title, sections: [])
        let l = CarPlayLiveList(template: t) { .init() }
        l.build = { [weak l] in l.map(build) ?? .init() }
        attach(l)
        ic.pushTemplate(t, animated: true, completion: nil)
        return l
    }

    private func open(_ target: CarPlayLogic.Target) {
        guard let app else { return }
        let title = CarPlayLogic.title(target)
        switch target {
        case .libraryPlaylists:
            _ = push(title) { [weak self] _ in
                guard let self else { return .init() }
                return .one(CarPlayLogic.playlists(app.library.playlists, offline: self.isOffline, held: self.held, cap: self.cap), empty: L("Nothing here yet."))
            }
        case .libraryAlbums:
            _ = push(title) { [weak self] _ in
                guard let self else { return .init() }
                return .one(CarPlayLogic.albums(app.library.albums, offline: self.isOffline, held: self.held, cap: self.cap), empty: L("Nothing here yet."))
            }
        case .libraryArtists:
            _ = push(title) { [weak self] _ in
                guard let self else { return .init() }
                return .one(CarPlayLogic.artists(app.library.artists, offline: self.isOffline, cap: self.cap),
                            empty: self.isOffline ? L("Not available offline.") : L("Nothing here yet."))
            }
        case .libraryDownloaded:
            _ = push(title) { [weak self] _ in
                guard let self else { return .init() }
                return .one(CarPlayLogic.downloaded(app.offline.index, cap: self.cap), empty: L("Nothing here yet."))
            }
        case .liked:
            _ = push(title) { [weak self] _ in
                let at = app.likes.tracks.isEmpty ? app.library.likedAt : app.likes.tracks
                return self?.trackList(LibraryText.likedOrder(at, rows: app.library.likedRows, sort: .recent), target: target,
                                       state: app.library.likedLoaded || !app.library.likedRows.isEmpty ? .loaded : .loading) ?? .init()
            }
            Task {
                await app.library.loadLiked()
                let at = app.likes.tracks.isEmpty ? app.library.likedAt : app.likes.tracks
                await app.library.fillLiked(at.keys.filter { app.library.likedRows[$0] == nil })
            }
        case .downloaded(let id, _, _):
            _ = push(title) { [weak self] _ in
                self?.trackList(app.offline.downloadedTracks(of: id), target: target, state: .loaded) ?? .init()
            }
        case .album, .playlist, .artist, .mix, .topSongs:
            let source = CarPlayTrackSource()
            let l = push(title) { [weak self] _ in self?.trackList(source.tracks, target: target, state: source.state) ?? .init() }
            load(target, into: source) { [weak self, weak l] in
                guard let self, let l else { return }
                self.render(l)
            }
        case .track, .queue:
            break
        }
    }

    private func trackList(_ all: [Track], target: CarPlayLogic.Target, state: CarPlayTrackSource.State) -> CarPlayBuilt {
        guard let app else { return .init() }
        let offline = isOffline
        let shown = CarPlayLogic.playable(all, offline: offline, has: app.offline.has)
        let empty: String? = switch state {
        case .loading: L("Loading…")
        case .failedOffline: L("Not available offline. Open it once with a connection, or download it.")
        case .failed: L("Couldn’t load this — try again.")
        case .loaded: offline && !all.isEmpty ? L("Offline: only downloaded songs play") : L("Nothing here yet.")
        }
        let capped = Array(shown.prefix(cap))
        return CarPlayBuilt(sections: [.init(title: nil, rows: CarPlayLogic.trackRows(capped, cap: cap))], tracks: shown,
                            context: CarPlayLogic.context(target), empty: shown.isEmpty ? empty : nil)
    }

    /// The same loads the phone's pages run (DetailAlbumModel, PlaylistView, DetailArtistModel,
    /// DailyMixView, TopSongsView); offline a page never fetched falls back to its downloaded songs.
    private func load(_ target: CarPlayLogic.Target, into s: CarPlayTrackSource, changed: @escaping @MainActor () -> Void) {
        guard let app else { return }
        let api = app.account.api, scope = app.account.user?.id
        let finish: @MainActor ([Track], Error?, String?) -> Void = { tracks, error, heldId in
            var list = tracks
            if list.isEmpty, let heldId { list = app.offline.downloadedTracks(of: heldId) }
            s.tracks = list
            if let error, list.isEmpty { s.state = (error as? APIError) == .offline || Connectivity.shared.offline ? .failedOffline : .failed }
            else { s.state = .loaded }
            changed()
        }
        switch target {
        case .album(let id, _):
            Task {
                let m = DetailAlbumModel(id: id)
                await m.load(api: api, scope: scope)
                let error: Error? = m.loadFailed ? (m.failedOffline ? APIError.offline as Error : CarPlayLoadError.failed) : nil
                finish(m.tracks, error, id)
            }
        case .playlist(let id, _):
            if let kept = app.library.details[id] { s.tracks = kept.tracks; s.state = .loaded; changed() }
            Task {
                do {
                    let d = try await api.playlist(id)
                    app.library.remember(d)
                    finish(d.tracks, nil, id)
                } catch {
                    if s.tracks.isEmpty { finish([], error, id) }
                }
            }
        case .artist(let id, _):
            let m = DetailArtistModel(id: id)
            // The artist model also loads the discography; show the songs as soon as they come.
            watchArtist(m, into: s, changed: changed)
            Task { await m.load(api: api, scope: scope) }
        case .mix(let id, _, _):
            Task {
                do { finish(StreamPolicy.dropDisliked(try await api.mix(id, limit: 50).items, prefs: app.account.prefs), nil, nil) }
                catch { finish([], error, nil) }
            }
        case .topSongs(let year):
            Task {
                do { finish(StreamPolicy.dropDisliked(try await api.topSongs(year: year), prefs: app.account.prefs), nil, nil) }
                catch { finish([], error, nil) }
            }
        default:
            break
        }
    }

    private func watchArtist(_ m: DetailArtistModel, into s: CarPlayTrackSource, changed: @escaping @MainActor () -> Void) {
        s.keep = m
        // Weak both ways: the model (kept by the source, kept by the list) goes with the template.
        watch({ [weak m] in _ = m?.tracks; _ = m?.loading }) { [weak s, weak m] in
            guard let s, let m else { return }
            s.tracks = m.tracks
            s.state = m.loading ? .loading : m.tracks.isEmpty && Connectivity.shared.offline ? .failedOffline : .loaded
            changed()
        }
    }

    // MARK: Player

    private func playerMoved() {
        guard let app else { return }
        lists.removeAll { $0.template == nil }
        for l in lists {
            for (item, row) in l.items {
                let on = mark(row)
                if item.isPlaying != on { item.isPlaying = on }
            }
        }
        let ctx = app.player.context
        if from.ctx != ctx {
            from = (ctx, NowPlayingFrom.immediate(ctx)?.name ?? NowPlayingFrom.fallback.name)
            if NowPlayingFrom.immediate(ctx) == nil {
                let api = app.account.api
                Task { [weak self] in
                    let r = await NowPlayingFrom.resolve(ctx, api: api)
                    guard let self, self.from.ctx == ctx else { return }
                    self.from.name = r.name
                    if let q = self.queueList { self.render(q) }
                }
            }
        }
        if let q = queueList { render(q) }
    }

    private func setUpNowPlaying() {
        let np = CPNowPlayingTemplate.shared
        np.isUpNextButtonEnabled = true
        np.upNextTitle = L("Queue")
        np.isAlbumArtistButtonEnabled = false
        np.add(self)
        updateNowPlayingButtons()
    }

    private func updateNowPlayingButtons() {
        guard let app else { return }
        let p = app.player
        let shuffle = CPNowPlayingShuffleButton { [weak self] _ in
            MainActor.assumeIsolated {
                guard let p = self?.app?.player else { return }
                p.setShuffle(CarPlayLogic.nextShuffle(p.shuffle))
            }
        }
        shuffle.isSelected = CarPlayLogic.shuffleSelected(p.shuffle)
        let repeatButton = CPNowPlayingRepeatButton { [weak self] _ in
            MainActor.assumeIsolated {
                guard let p = self?.app?.player else { return }
                p.setRepeat(CarPlayLogic.nextRepeat(p.repeatMode))
            }
        }
        repeatButton.isSelected = CarPlayLogic.repeatSelected(p.repeatMode)
        // The car draws shuffle / repeat state from the command centre; NowPlayingCenter keeps
        // those commands disabled, so only their displayed type is set here.
        let center = MPRemoteCommandCenter.shared()
        center.changeShuffleModeCommand.currentShuffleType = CarPlayLogic.shuffleType(p.shuffle)
        center.changeRepeatModeCommand.currentRepeatType = CarPlayLogic.repeatType(p.repeatMode)
        var buttons: [CPNowPlayingButton] = [shuffle, repeatButton]
        if let id = p.current?.id, let img = UIImage(systemName: CarPlayLogic.likeSymbol(app.likes.isLiked(id))) {
            buttons.append(CPNowPlayingImageButton(image: img) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let likes = self?.app?.likes else { return }
                    Task { await NowPlayingLike.toggle(id, likes: likes) }
                }
            })
        }
        CPNowPlayingTemplate.shared.updateNowPlayingButtons(buttons)
    }

    private func buildQueue() -> CarPlayBuilt {
        guard let app else { return .init() }
        let p = app.player, q = p.queue
        let parts = CarPlayLogic.queueParts(count: q.count, index: p.index, queuedFlags: p.queuedFlags,
                                            hasContext: p.context != nil, fromName: from.name, cap: cap)
        let sections = parts.map { part in
            CarPlayLogic.Section(title: part.title, rows: part.indices.map { i in
                CarPlayLogic.Row(title: q[i].title, subtitle: CarPlayLogic.artistLine(q[i]), art: CoverSource(q[i]), glyph: .song, target: .queue(index: i))
            })
        }
        return CarPlayBuilt(sections: sections, empty: sections.isEmpty ? L("Add to your queue") : nil)
    }
}

extension CarPlayController: CPNowPlayingTemplateObserver {
    nonisolated func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
        MainActor.assumeIsolated {
            if let q = queueList, let t = q.template, ic.templates.contains(where: { $0 === t }) { return }
            let t = CPListTemplate(title: L("Queue"), sections: [])
            let l = CarPlayLiveList(template: t) { [weak self] in self?.buildQueue() ?? .init() }
            queueList = l
            attach(l)
            ic.pushTemplate(t, animated: true, completion: nil)
        }
    }

    nonisolated func nowPlayingTemplateAlbumArtistButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {}
}

/// What one list shows.
struct CarPlayBuilt {
    var sections: [CarPlayLogic.Section] = []
    /// The (offline-filtered) list a track row plays from.
    var tracks: [Track] = []
    var context: String?
    var empty: String?

    static func one(_ rows: [CarPlayLogic.Row], empty: String?) -> CarPlayBuilt {
        CarPlayBuilt(sections: [.init(title: nil, rows: rows)], empty: rows.isEmpty ? empty : nil)
    }
}

/// A template plus how to rebuild it.
@MainActor
final class CarPlayLiveList {
    weak var template: CPListTemplate?
    var build: @MainActor () -> CarPlayBuilt
    var last: [CarPlayLogic.Section]?
    var tracks: [Track] = []
    var context: String?
    var items: [(CPListItem, CarPlayLogic.Row)] = []

    init(template: CPListTemplate, build: @escaping @MainActor () -> CarPlayBuilt) {
        self.template = template
        self.build = build
    }
}

/// A drill-in's songs as they load.
@MainActor
final class CarPlayTrackSource {
    enum State { case loading, loaded, failed, failedOffline }
    var tracks: [Track] = []
    var state: State = .loading
    /// Keeps a page model alive while it loads.
    var keep: AnyObject?
}

private enum CarPlayLoadError: Error { case failed }
