import XCTest
@testable import Slopify

/// The Generate dialog's words (GeneratePlaylist.jsx, App.jsx onDone) and the "+" sheet.
final class GeneratePlaylistTests: XCTestCase {
    func testCreateSheetOffersGeneratedPlaylistBetweenPlaylistAndFolder() {
        var ran = ""
        let items = LibraryCreate.items(playlist: { ran = "playlist" }, generate: { ran = "generate" }, folder: { ran = "folder" })
        XCTAssertEqual(items.map(\.label), [L("Playlist"), L("Generated playlist (AI)"), L("Folder")])
        items[1].action?()
        XCTAssertEqual(ran, "generate")
    }

    func testTimeLeftCountsDownInFiveSecondSteps() {
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 4000, elapsedMs: 0), L("Almost done"))
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 30000, elapsedMs: 26000), L("Almost done"))
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 21000, elapsedMs: 0), L("About {s} s left", ["s": 25]))
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 21000, elapsedMs: 2000), L("About {s} s left", ["s": 20]))
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 60000, elapsedMs: 0), L("About {m} min left", ["m": 1]))
        XCTAssertEqual(GenerateLogic.timeLeft(leftMs: 83000, elapsedMs: 0), L("About {m} min {s} s left", ["m": 1, "s": 25]))
    }

    func testBarIsNeverThinnerThanThreePercent() {
        XCTAssertEqual(GenerateLogic.fill(nil), 0.03)
        XCTAssertEqual(GenerateLogic.fill(0.5), 0.5)
        XCTAssertEqual(GenerateLogic.fill(2), 1)
    }

    func testStageDetail() {
        let info = GenerateJob.Info(stages: nil, leftMs: nil, title: nil, vibe: nil, found: 120, foundNew: 90)
        XCTAssertEqual(GenerateLogic.stageDetail(.init(key: "find", label: "Find", state: "done", detail: "x"), info: info),
                       L("{n} songs, {fresh} you have not played", ["n": 120, "fresh": 90]))
        XCTAssertEqual(GenerateLogic.stageDetail(.init(key: "pick", label: "Pick", state: "active", detail: "12 of 25"), info: info), "12 of 25")
        XCTAssertNil(GenerateLogic.stageDetail(.init(key: "pick", label: "Pick", state: "pending", detail: "12 of 25"), info: info))
    }

    private func result(regenerated: Bool = false, requested: Int = 0) -> GenerateJob.Result {
        .init(playlistId: "pl_1", name: "Rainy", regenerated: regenerated, count: 25, requested: requested)
    }

    func testOutcomeOfANewPlaylist() {
        XCTAssertEqual(GenerateLogic.outcome(result(), hidden: false), .open("pl_1"))
        XCTAssertEqual(GenerateLogic.outcome(result(), hidden: true), .toast(L("{name} is ready in Your Library.", ["name": "Rainy"])))
        let one = L("1 more song is downloading and will be added.")
        XCTAssertEqual(GenerateLogic.outcome(result(requested: 1), hidden: false), .toast(one))
        XCTAssertEqual(GenerateLogic.outcome(result(requested: 3), hidden: true),
                       .toast(L("{name} is ready in Your Library. {more}", ["name": "Rainy", "more": L("{n} more songs are downloading and will be added.", ["n": 3])])))
    }

    func testOutcomeOfARegeneratedPlaylist() {
        let text = L("{name} regenerated", ["name": "Rainy"])
        XCTAssertEqual(GenerateLogic.outcome(result(regenerated: true), hidden: false), .openAndToast("pl_1", text))
        XCTAssertEqual(GenerateLogic.outcome(result(regenerated: true), hidden: true), .toast(text))
    }

    func testJobDecodesTheServerShape() throws {
        let json = #"{"id":"a1b2c3d4e5f60718","kind":"ai-playlist","state":"running","step":"Finding","progress":0.4,"info":{"stages":[{"key":"plan","label":"Plan","state":"done","detail":null},{"key":"find","label":"Find","state":"active","detail":"sound"}],"leftMs":21000,"at":1,"title":"Rainy","vibe":"soft","found":120,"foundNew":90,"bySound":40},"result":null,"error":null,"created":1,"finished":null}"#
        let j = try JSONDecoder().decode(GenerateJob.self, from: Data(json.utf8))
        XCTAssertEqual(j.state, "running")
        XCTAssertEqual(j.info?.stages?.map(\.state), ["done", "active"])
        XCTAssertEqual(j.info?.leftMs, 21000)
        let done = #"{"id":"a","state":"done","result":{"playlistId":"pl_9","name":"Rainy","regenerated":false,"count":25,"poolSize":300,"requested":2,"missing":[{"artist":"A","title":"T"}],"known":5,"tracks":[{"id":"t","known":true}],"by":"brain"}}"#
        let r = try JSONDecoder().decode(GenerateJob.self, from: Data(done.utf8)).result
        XCTAssertEqual(r?.playlistId, "pl_9")
        XCTAssertEqual(r?.requested, 2)
    }
}
