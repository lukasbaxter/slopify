import XCTest
@testable import Slopify

private let madeTrack = #"{"id":"t1","title":"Song","artist":"Band","artists":["Band"],"artistIds":["ar"],"albumId":"al","album":"A","albumArtist":"Band","trackNo":1,"discNo":1,"year":2020,"genres":[],"durationMs":1000,"codec":null,"bitrate":null,"cover":null,"format":null,"gain":{"track":null,"album":null},"identity":{"state":"matched","score":1},"addedAt":1}"#
private let rockJSON = ##"{"id":"rock","title":"Rock Classics","kind":"genre","description":"Rock legends and the rock you play","color":"#B3261E","art":"art_0123456789abcdef0123456789abcdef01234567","count":50,"artists":[{"id":"ar","name":"Band"}]}"##
private let thisIsJSON = ##"{"id":"thisis:ar1","title":"This Is Drake","kind":"thisis","description":"The essential tracks","color":"#1E3264","art":null,"count":30,"artists":[]}"##

private func mfy(_ id: String, _ title: String) -> MadeForYou { MadeForYou(id: id, title: title, description: "d") }
private func mfyTrack(_ id: String, _ title: String) -> Track {
    Track(id: id, title: title, artist: "Rock Band", artists: ["Rock Band"], artistIds: ["rb"], albumId: "a", album: "A", albumArtist: "Rock Band",
          trackNo: nil, discNo: nil, year: nil, genres: nil, durationMs: 1000, codec: nil, bitrate: nil, cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
}

@MainActor
final class MadeForYouEndpointTests: XCTestCase {
    func testListDecodes() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/made": (200, #"{"items":[\#(rockJSON),\#(thisIsJSON)],"building":false}"#)]
        let list = try await api.madeList()
        XCTAssertEqual(CoreStubProtocol.seen.map(\.url.absoluteString), ["https://m.example.com/api/made"])
        XCTAssertEqual(list.map(\.id), ["rock", "thisis:ar1"])
        XCTAssertEqual(list[0].title, "Rock Classics")
        XCTAssertEqual(list[0].kind, "genre")
        XCTAssertEqual(list[0].description, "Rock legends and the rock you play")
        XCTAssertEqual(list[0].color, "#B3261E")
        XCTAssertEqual(list[0].art, "art_0123456789abcdef0123456789abcdef01234567")
        XCTAssertEqual(list[0].count, 50)
        XCTAssertEqual(list[0].artists, [MixArtist(id: "ar", name: "Band")])
        XCTAssertNil(list[1].art)
    }

    func testListWithOnlyIdAndTitleDecodes() throws {
        let l = try JSONDecoder().decode(MadeForYouList.self, from: Data(#"{"items":[{"id":"x","title":"X"}]}"#.utf8))
        XCTAssertEqual(l.items, [MadeForYou(id: "x", title: "X")])
        XCTAssertNil(l.building)
    }

    /// "thisis:<artistId>" is one path part: the colon percent-encoded, nothing split.
    func testDetailIdIsOneEncodedSegment() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["ar1": (200, ##"{"id":"thisis:ar1","title":"This Is Drake","description":"d","color":"#1E3264","art":null,"items":[\##(madeTrack)]}"##),
                                    "/api/made/rock": (200, #"{"id":"rock","title":"Rock Classics","items":[]}"#),
                                    "b c": (200, #"{"id":"a/b c","title":"X","items":[]}"#)]
        let d = try await api.made("thisis:ar1")
        _ = try await api.made("rock")
        _ = try await api.made("a/b c")
        XCTAssertEqual(CoreStubProtocol.seen.map(\.url.absoluteString),
                       ["https://m.example.com/api/made/thisis%3Aar1", "https://m.example.com/api/made/rock",
                        "https://m.example.com/api/made/a%2Fb%20c"])
        XCTAssertEqual(d.title, "This Is Drake")
        XCTAssertEqual(d.items.map(\.id), ["t1"])
    }

    func testSearchCarriesMade() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/search": (200, #"{"tracks":[],"albums":[],"artists":[],"made":[\#(rockJSON)]}"#)]
        let r = try await api.search("rock")
        XCTAssertEqual(r.made?.map(\.id), ["rock"])
    }

    /// An older server sends no `made`: the search still decodes and the row is hidden.
    func testOlderServerWithoutMade() async throws {
        let api = CoreStubProtocol.client()
        CoreStubProtocol.answers = ["/api/search": (200, #"{"tracks":[\#(madeTrack)],"albums":[],"artists":[]}"#)]
        let r = try await api.search("song")
        XCTAssertNil(r.made)
        let page = SearchPage(query: "song", results: r, playlists: [])
        XCTAssertEqual(page.made, [])
        XCTAssertEqual(SearchLogic.sections(page, type: .all), [.rows([.song(r.tracks[0])])])
    }

    /// Browse data kept by an older build (no `made`) still loads.
    func testKeptBrowseDataWithoutMadeLoads() throws {
        let s = try JSONDecoder().decode(SearchBrowseData.Saved.self, from: Data(#"{"tiles":[],"firstAlbums":["a"]}"#.utf8))
        XCTAssertNil(s.made)
        XCTAssertEqual(s.firstAlbums, ["a"])
    }
}

final class MadeForYouSearchTests: XCTestCase {
    private func page(made: [MadeForYou]) -> SearchPage {
        SearchPage(query: "rock", results: SearchResults(tracks: [mfyTrack("t1", "Rock Song")], albums: [], artists: [], made: made),
                   playlists: [Playlist(id: "p1", name: "rock mix")])
    }

    func testMadeRowComesFirst() {
        let made = [mfy("rock", "Rock Classics"), mfy("thisis:rb", "This Is Rock Band")]
        let s = SearchLogic.sections(page(made: made), type: .all)
        XCTAssertEqual(s.count, 2)
        XCTAssertEqual(s.first, .made(made))
        guard case .rows(let rows) = s[1] else { return XCTFail("rows second") }
        XCTAssertEqual(rows.map(\.key), ["Song:t1", "Playlist:p1"])
    }

    func testMadeAloneIsNotNoResults() {
        let p = SearchPage(query: "xmas", results: SearchResults(tracks: [], albums: [], artists: [], made: [mfy("christmas", "Christmas Hits")]), playlists: [])
        XCTAssertEqual(SearchLogic.sections(p, type: .all), [.made([mfy("christmas", "Christmas Hits")])])
    }

    func testEmptyMadeHidesRow() {
        XCTAssertEqual(SearchLogic.sections(page(made: []), type: .all).count, 1)
        if case .made = SearchLogic.sections(page(made: []), type: .all).first { XCTFail("no row without made") }
    }

    func testChipsThatAreNotPlaylistsHideRow() {
        let made = [mfy("rock", "Rock Classics")]
        XCTAssertEqual(SearchLogic.sections(page(made: made), type: .playlists).first, .made(made))
        XCTAssertEqual(SearchLogic.sections(page(made: made), type: .songs), [.rows([.song(mfyTrack("t1", "Rock Song"))])])
        XCTAssertEqual(SearchLogic.sections(page(made: made), type: .everywhere), [])
    }

    func testContext() { XCTAssertEqual(SearchLogic.madeContext("thisis:a"), "made:thisis:a") }
}
