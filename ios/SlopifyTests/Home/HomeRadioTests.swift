import XCTest
@testable import Slopify

/// Go to radio (API.md §14.4) and Home's Daily Mix subtitles (§14.3).
@MainActor
final class HomeRadioTests: XCTestCase {
    override func setUp() { Localizer.shared.setUserPick("en") }

    private let track = #"{"id":"t1","title":"Song","artist":"Band","artists":["Band"],"artistIds":["ar"],"albumId":"al","album":"A","albumArtist":"Band","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1}"#

    func testRadioPostsToTheSeedAndRefreshOnlyWhenAsked() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/radio/ar": (200, #"{"id":"radio:ar","made":1794553562334,"from":"brain","seed":{"kind":"artist","id":"ar","name":"Band","artistId":"ar","albumId":null},"artists":[{"id":"ar","name":"Band"},{"id":"b","name":"Other"}],"items":[\#(track)]}"#)]
        let r = try await api.radio("ar")
        _ = try await api.radio("ar", refresh: true)
        let seen = CoreStubProtocol.seen
        XCTAssertEqual(seen.map(\.method), ["POST", "POST"])
        XCTAssertEqual(seen[0].url.absoluteString, "https://m.example.com/api/radio/ar")
        XCTAssertEqual(seen[1].url.absoluteString, "https://m.example.com/api/radio/ar?refresh=1")
        XCTAssertTrue(seen[0].body?.isEmpty ?? true)
        XCTAssertEqual(r.id, "radio:ar"); XCTAssertEqual(r.seed.kind, "artist"); XCTAssertEqual(r.seed.name, "Band")
        XCTAssertNil(r.seed.albumId); XCTAssertEqual(r.items.map(\.id), ["t1"]); XCTAssertEqual(r.artists?.map(\.name), ["Band", "Other"])
    }

    func testDailyMixesAsksForTheSeedsWithTheOffset() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/daily-mixes": (200, #"{"items":[{"artistId":"a","day":"2026-11-13","from":"brain","artists":[{"id":"a","name":"A"},{"id":"b","name":"B"}]}]}"#)]
        let got = try await api.dailyMixes(ids: ["a", "b"])
        let q = URLComponents(url: CoreStubProtocol.seen[0].url, resolvingAgainstBaseURL: false)!.queryItems ?? []
        XCTAssertEqual(CoreStubProtocol.seen[0].method, "GET")
        XCTAssertEqual(q.first { $0.name == "ids" }?.value, "a,b")
        XCTAssertEqual(q.first { $0.name == "tzo" }?.value, String(-TimeZone.current.secondsFromGMT() / 60))
        XCTAssertEqual(got, [DailyMixSummary(artistId: "a", day: "2026-11-13", from: "brain", artists: [.init(id: "a", name: "A"), .init(id: "b", name: "B")])])
        CoreStubProtocol.seen = []
        let none = try await api.dailyMixes(ids: [])
        XCTAssertEqual(none, [])
        XCTAssertTrue(CoreStubProtocol.seen.isEmpty, "no seeds, no request")
    }

    func testSubtitlesNameTodaysArtists() {
        let s = DailyMixSummary(artistId: "a", day: "2026-11-13", from: nil, artists: [.init(id: "a", name: "Drake"), .init(id: "f", name: "Future"), .init(id: "t", name: "Travis Scott")])
        XCTAssertEqual(HomeLogic.dailyMixSub(seedName: "Drake", summary: s), "Drake, Future, Travis Scott and more")
        XCTAssertEqual(HomeLogic.dailyMixSub(seedName: "Drake", summary: nil), "Drake and more")
        XCTAssertNil(HomeLogic.mixSub([]))
    }

    func testNowPlayingNamesARadioAfterItsSeed() async {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/items/ar": (200, #"{"kind":"artist","item":{"id":"ar","name":"Band"}}"#)]
        XCTAssertEqual(NowPlayingFrom.itemId("radio:ar"), "ar")
        let from = await NowPlayingFrom.resolve("radio:ar", api: api)
        XCTAssertEqual(from, NowPlayingFrom(kind: "PLAYING FROM PLAYLIST", name: "Band Radio"))
    }

    func testRadioPagePieces() {
        XCTAssertEqual(HomeRadioLogic.title("Band"), "Band Radio")
        XCTAssertEqual(HomeRadioLogic.title(nil), "")
        XCTAssertEqual(HomeRadioLogic.context("ar"), "radio:ar")
        // (97 + 114) % 8 = 3, the web's sum of UTF-16 code units.
        XCTAssertEqual(HomeRadioLogic.colorIndex("ar"), 3)
        XCTAssertEqual(HomeRadioLogic.art(.init(kind: "artist", id: "ar", name: "B", artistId: "ar", albumId: nil)), .artist(id: "ar", image: nil))
        XCTAssertEqual(HomeRadioLogic.art(.init(kind: "track", id: "t", name: "S", artistId: "ar", albumId: "al")), .album(id: "al", art: nil))
        XCTAssertEqual(HomeRadioLogic.art(.init(kind: "playlist", id: "pl_1", name: "P", artistId: nil, albumId: nil)), .playlist(id: "pl_1", cover: nil))
    }

    func testARadioPlaysOnceAsItOpensAndAgainOnRefresh() {
        var a = HomeMixAutoplay()
        XCTAssertFalse(a.shouldPlay(count: 0, refresh: false), "nothing loaded yet")
        XCTAssertTrue(a.shouldPlay(count: 50, refresh: false))
        XCTAssertFalse(a.shouldPlay(count: 50, refresh: false), "coming back to the page")
        XCTAssertTrue(a.shouldPlay(count: 50, refresh: true))
    }

    func testHomeShowsTodaysSummaryAndAFreshAnswerReplacesTheKeptOne() async throws {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [HomeStubProtocol.self]
        let api = APIClient(baseURL: URL(string: "https://home.invalid")!, token: "t", session: URLSession(configuration: cfg))
        HomeStubProtocol.failing = []
        HomeStubProtocol.bodies = [
            "/api/home": #"{"recentAlbums":[],"topTracks":[\#(track)],"newestAlbums":[]}"#,
            "/api/daily-mixes": #"{"items":[{"artistId":"ar","day":"2026-11-12","from":"brain","artists":[{"id":"ar","name":"Band"},{"id":"y","name":"Yesterday"}]}]}"#,
        ]
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("home-radio-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = HomeStore(); a.cacheDir = dir; a.use(key: "srv|u")
        await a.load(api: api)
        XCTAssertEqual(a.mixSub(artistId: "ar", seedName: "Band"), "Band, Yesterday and more")
        HomeStubProtocol.bodies["/api/daily-mixes"] = #"{"items":[{"artistId":"ar","day":"2026-11-13","from":"brain","artists":[{"id":"ar","name":"Band"},{"id":"t","name":"Today"}]}]}"#
        let b = HomeStore(); b.cacheDir = dir; b.use(key: "srv|u")
        XCTAssertEqual(b.mixSub(artistId: "ar", seedName: "Band"), "Band, Yesterday and more", "the kept copy paints first")
        await b.load(api: api)
        XCTAssertEqual(b.mixSub(artistId: "ar", seedName: "Band"), "Band, Today and more")
    }
}
