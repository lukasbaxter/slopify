import CryptoKit
import Foundation
import WidgetKit

/// Keeps the home screen widgets up to date: writes what is playing and the recent shortcuts
/// (with their covers) where the widget extension reads them, and has WidgetKit redraw when that changes.
@MainActor
final class WidgetFeed {
    private let player: Player
    private let account: Account
    private var last: WidgetSnapshot
    private var nowTask: Task<Void, Never>?
    private var tilesTask: Task<Void, Never>?
    private var tileKey: [String] = []

    init(player: Player, account: Account) {
        self.player = player
        self.account = account
        last = WidgetStore.read() ?? WidgetSnapshot()
        WidgetBridge.toggle = { [weak self] in await self?.toggle() }
        watchPlayer()
        watchHome()
    }

    // MARK: - Pure

    /// The shortcuts shown as tiles: Liked Songs has no cover of its own and is left out.
    static func tiles(_ shortcuts: [HomeLogic.Shortcut]) -> [(tile: WidgetSnapshot.Tile, source: CoverSource)] {
        var out: [(WidgetSnapshot.Tile, CoverSource)] = []
        for s in shortcuts {
            switch s {
            case .liked: continue
            case .album(let a): out.append((.init(link: WidgetLink.album(a.id).url.absoluteString, title: a.name, cover: nil, round: false), CoverSource(a)))
            case .playlist(let p): out.append((.init(link: WidgetLink.playlist(p.id).url.absoluteString, title: p.name, cover: nil, round: false), CoverSource(p)))
            case .artist(let a): out.append((.init(link: WidgetLink.artist(a.id).url.absoluteString, title: a.name, cover: nil, round: true), .artist(id: a.id, image: a.image)))
            }
            if out.count == WidgetLogic.tileCount { break }
        }
        return out
    }

    static func coverName(_ url: URL) -> String {
        SHA256.hash(data: Data(url.absoluteString.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined() + ".img"
    }

    static func route(_ link: WidgetLink) -> Route? {
        switch link {
        case .nowPlaying: nil
        case .album(let id): .album(id: id)
        case .playlist(let id): .playlist(id: id)
        case .artist(let id): .artist(id: id)
        case .radio(let id, let name): .radio(seedId: id, name: name)
        }
    }

    // MARK: - Now playing

    private func watchPlayer() {
        withObservationTracking {
            _ = (player.current?.id, player.isPlaying, player.isLoading, player.duration, player.progressTick, account.state)
        } onChange: { [weak self] in
            Task { @MainActor in self?.playerChanged(); self?.watchPlayer() }
        }
    }

    private func playerChanged() {
        guard account.state == .signedIn else {
            nowTask?.cancel(); tilesTask?.cancel(); tileKey = []
            commit(WidgetSnapshot())
            return
        }
        guard let t = player.current else { return } // nothing loaded yet: keep what was last shown
        var now = WidgetSnapshot.Now(
            id: t.id, title: t.title, artist: t.creditLine, cover: nil, tint: nil,
            playing: player.isPlaying && !player.isLoading, position: player.positionNow(),
            duration: player.duration > 0 ? player.duration : t.duration, at: Date())
        if let old = last.now, old.id == t.id {
            now.cover = old.cover; now.tint = old.tint
            guard WidgetLogic.differs(old, now) else { return }
            var s = last; s.now = now
            commit(s)
            if now.cover != nil { return }
        }
        // A new song (or its picture never arrived): fetch the cover, then show it all at once.
        let api = account.api
        guard let url = CoverSource(t).url(api, size: 300) else { var s = last; s.now = now; commit(s); return }
        nowTask?.cancel()
        nowTask = Task { [weak self] in
            let name = await Self.saveCover(url)
            let tint = await ArtworkColor.shared.mini(url)
            guard let self, !Task.isCancelled, self.player.current?.id == now.id else { return }
            var fresh = now
            fresh.cover = name; fresh.tint = tint.map { [Int($0.r.rounded()), Int($0.g.rounded()), Int($0.b.rounded())] }
            fresh.playing = self.player.isPlaying && !self.player.isLoading
            fresh.position = self.player.positionNow(); fresh.at = Date()
            var s = self.last; s.now = fresh
            self.commit(s)
        }
    }

    private func toggle() async {
        // Started in the background for this tap: sign-in state and the saved queue come first.
        await AppModel.current?.start()
        guard player.current != nil else { return }
        player.togglePlay()
    }

    // MARK: - Recents

    private func watchHome() {
        withObservationTracking { _ = HomeStore.shared.shortcuts } onChange: { [weak self] in
            Task { @MainActor in self?.homeChanged(); self?.watchHome() }
        }
        homeChanged()
    }

    private func homeChanged() {
        guard account.state == .signedIn else { return }
        let picked = Self.tiles(HomeStore.shared.shortcuts)
        let api = account.api
        let urls = picked.map { $0.source.url(api, size: 240) }
        let key = zip(picked, urls).map { $0.0.tile.link + "|" + ($0.1?.absoluteString ?? "") }
        guard key != tileKey, !picked.isEmpty else { return }
        tileKey = key
        tilesTask?.cancel()
        tilesTask = Task { [weak self] in
            var tiles: [WidgetSnapshot.Tile] = []
            for (p, url) in zip(picked, urls) {
                var t = p.tile
                if let url { t.cover = await Self.saveCover(url) }
                tiles.append(t)
            }
            guard let self, !Task.isCancelled else { return }
            var s = self.last; s.recents = tiles
            self.commit(s)
        }
    }

    // MARK: - Shared store

    private func commit(_ s: WidgetSnapshot) {
        guard s != last else { return }
        last = s
        guard WidgetStore.write(s) else { return }
        WidgetCenter.shared.reloadAllTimelines()
        WidgetStore.sweep(keeping: Set(([s.now?.cover] + s.recents.map(\.cover)).compactMap { $0 }))
    }

    /// The picture, stored for the widgets; its name, or nil when it could not be fetched.
    private static func saveCover(_ url: URL) async -> String? {
        guard WidgetStore.group != nil else { return nil }
        let name = coverName(url)
        if WidgetStore.hasCover(name) { return name }
        guard let data = await ImageLoader.shared.data(url) else { return nil }
        return WidgetStore.saveCover(name, data) ? name : nil
    }
}
