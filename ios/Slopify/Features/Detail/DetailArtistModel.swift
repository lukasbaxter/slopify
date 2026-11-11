import Foundation

/// Artist page data (App.jsx openArtistById + Library.jsx discography / similar / requests).
@MainActor @Observable
final class DetailArtistModel {
    enum Discog: Equatable { case loading, loaded([Release]), failed }

    let id: String
    private(set) var artist: Artist?
    private(set) var followed = false
    private(set) var albums: [Album] = []
    private(set) var appearsOn: [Album] = []
    /// In popular order once known.
    private(set) var tracks: [Track] = []
    private(set) var loading = true
    private(set) var sampled: RGB?
    private(set) var discog: Discog = .loading
    private(set) var similar: [EverywhereResults.ArtistHit] = []
    /// album_id -> this client's request state (queued | exists | error).
    private(set) var requesting: [String: String] = [:]
    var followOverride: Bool?

    private var popular: [String] = []
    // Kept for the session (Library.jsx component state), keyed by artist id.
    private static var discogCache: [String: [Release]] = [:]
    private static var similarCache: [String: [EverywhereResults.ArtistHit]] = [:]

    init(id: String) {
        self.id = id
        if let d = Self.discogCache[id] { discog = .loaded(d) }
        similar = Self.similarCache[id] ?? []
    }

    var context: String { "artist:\(id)" }
    var hero: RGB { ColorMath.detailHero(sampled: sampled, isArtist: true) }
    /// `bannerUrl(item)`: the wide photo, else the portrait; nil = flat hero.
    var hasBanner: Bool { artist?.banner != nil || artist?.image != nil }

    var entries: [DetailLogic.Entry] {
        let rels: [Release]
        if case .loaded(let r) = discog { rels = r } else { rels = [] }
        return DetailLogic.entries(releases: rels, albums: albums)
    }

    func load(api: APIClient, scope: String?, cache: DetailCache? = nil) async {
        let cache = cache ?? .shared
        let key = "ar.\(id)"
        if let kept: DetailArtistPage = cache.load(key, scope: scope) {
            apply(kept.detail); popular = kept.popular ?? []
            tracks = DetailLogic.popularOrder(kept.detail.tracks, ids: popular)
            loading = false
        }
        let disco = discog == .loading || discog == .failed ? Task { await self.loadDiscography(api: api) } : nil
        let sim = similar.isEmpty ? Task { await self.loadSimilar(api: api) } : nil
        do {
            let d = try await api.artist(id)
            apply(d)
            tracks = DetailLogic.popularOrder(d.tracks, ids: popular)
            loading = false
            cache.save(DetailArtistPage(detail: d, popular: popular.isEmpty ? nil : popular), key, scope: scope)
            if let ids = try? await api.artistPopular(id), !ids.isEmpty {
                popular = ids
                tracks = DetailLogic.popularOrder(d.tracks, ids: ids)
                cache.save(DetailArtistPage(detail: d, popular: ids), key, scope: scope)
            }
        } catch {
            loading = false
        }
        await disco?.value
        await sim?.value
    }

    private func apply(_ d: ArtistDetail) {
        artist = d.artist; followed = d.followed; albums = d.albums; appearsOn = d.appearsOn
    }

    func sampleColour(api: APIClient) async {
        sampled = await ArtworkColor.shared.vibrant(api.imageURL(id: id, size: 120))
    }

    func loadDiscography(api: APIClient) async {
        discog = .loading
        do {
            let d = try await api.discography(id)
            discog = .loaded(d.releases)
            Self.discogCache[id] = d.releases
        } catch {
            discog = .failed
        }
    }

    private func loadSimilar(api: APIClient) async {
        guard let s = try? await api.similar(id) else { return }
        similar = s
        Self.similarCache[id] = s
    }

    // MARK: Requests

    func requestState(_ e: DetailLogic.Entry) -> String? {
        DetailLogic.requestState(mine: e.mbid.flatMap { requesting[$0] }, server: e.requestStatus)
    }

    /// Any missing release on its way: poll the discography until it lands.
    var hasPending: Bool {
        entries.contains { $0.inLib == nil && requestState($0).map { DetailLogic.pending.contains($0) } == true }
    }

    func request(_ e: DetailLogic.Entry, api: APIClient) async throws {
        guard let mbid = e.mbid else { return }
        requesting[mbid] = "queued"
        do {
            let st = try await api.requestAlbum(mbid) ?? "queued"
            requesting[mbid] = st
            if case .loaded(var rels) = discog {
                for i in rels.indices where rels[i].album_id == mbid { rels[i].requestStatus = st }
                discog = .loaded(rels); Self.discogCache[id] = rels
            }
        } catch {
            requesting[mbid] = "error"
            throw error
        }
    }

    /// One quiet re-read while a request is pending (no loading state, errors ignored).
    func refreshDiscography(api: APIClient) async {
        guard let d = try? await api.discography(id) else { return }
        discog = .loaded(d.releases)
        Self.discogCache[id] = d.releases
    }
}
