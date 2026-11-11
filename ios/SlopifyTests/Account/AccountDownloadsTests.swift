import XCTest
@testable import Slopify

@MainActor
final class AccountDownloadsFakeSource: AccountDownloadsSource {
    var answers: [DownloadScope: DownloadsPage] = [:]
    var failRetry: Error?
    var retried: [Int] = []
    var calls: [DownloadScope] = []
    /// When set, `downloads` waits for it before answering.
    var gate: CheckedContinuation<Void, Never>?
    var holdNext = false

    func downloads(scope: DownloadScope) async throws -> DownloadsPage {
        calls.append(scope)
        if holdNext { holdNext = false; await withCheckedContinuation { gate = $0 } }
        guard let a = answers[scope] else { throw APIError.http(503, "lidarr is not configured") }
        return a
    }
    func retry(id: Int) async throws {
        if let failRetry { throw failRetry }
        retried.append(id)
    }
    func albumTracks(_ albumId: String) async throws -> [Track] { [] }
}

final class AccountDownloadsLogicTests: XCTestCase {
    let now: Double = 1_762_800_000_000

    // JSON from docs/API.md §18.2.
    func testDecodes() throws {
        let json = #"""
        {"scope":"mine","items":[{"id":123,"albumId":"mbid","artist":"A","title":"T","type":"Album","year":"2020","image":null,
        "state":"downloading","total":12,"done":4,"queuePos":null,"requested":1762800000000,"started":null,"progressAt":1762800000000,"finished":null,
        "reason":null,"via":"soulseek","detail":null,"libraryAlbumId":null,"source":"request","note":null,"mine":true,
        "search":{"at":1762800000000,"results":3,"outcome":"nomatch"},"failedImport":false}],
        "counts":{"downloading":1},"stuckAfterMs":86400000,"watcher":null,"now":1762800000000}
        """#
        let d = try JSONDecoder().decode(DownloadsPage.self, from: Data(json.utf8))
        XCTAssertEqual(d.items.count, 1)
        XCTAssertEqual(d.items[0].done, 4)
        XCTAssertEqual(d.items[0].search?.outcome, "nomatch")
        XCTAssertNil(d.watcher)
        XCTAssertEqual(d.stuckAfterMs, 86_400_000)
        let y = try JSONDecoder().decode(DownloadsPage.self, from: Data(#"{"items":[{"id":1,"title":"x","state":"done","year":1999}]}"#.utf8))
        XCTAssertEqual(y.items[0].year, "1999")
    }

    func testTimeWords() {
        XCTAssertEqual(AccountDownloadsLogic.ago(nil, now: now), "")
        XCTAssertEqual(AccountDownloadsLogic.ago(now - 30_000, now: now), "just now")
        XCTAssertEqual(AccountDownloadsLogic.ago(now - 5 * 60_000, now: now), "5 min ago")
        XCTAssertEqual(AccountDownloadsLogic.ago(now - 3 * 3_600_000, now: now), "3 h ago")
        XCTAssertEqual(AccountDownloadsLogic.ago(now - 26 * 3_600_000, now: now), "1 day ago")
        XCTAssertEqual(AccountDownloadsLogic.ago(now - 72 * 3_600_000, now: now), "3 days ago")
        XCTAssertEqual(AccountDownloadsLogic.duration(ms: 10_000), "1 min")
        XCTAssertEqual(AccountDownloadsLogic.duration(ms: 86_400_000), "24 h")
        XCTAssertEqual(AccountDownloadsLogic.inTime(now + 3000, now: now), "any moment now")
        XCTAssertEqual(AccountDownloadsLogic.inTime(now + 40_000, now: now), "in 40 s")
        XCTAssertEqual(AccountDownloadsLogic.inTime(now + 600_000, now: now), "in 10 min")
        XCTAssertEqual(AccountDownloadsLogic.cleanError("503: lidarr is not configured"), "lidarr is not configured")
    }

    func testSummaryAndSections() {
        let items = [DownloadsPage.Item(id: 1, title: "a", state: "done"), .init(id: 2, title: "b", state: "downloading"),
                     .init(id: 3, title: "c", state: "done"), .init(id: 4, title: "d", state: "weird")]
        XCTAssertEqual(AccountDownloadsLogic.summary(items).map(\.text), ["1 downloading", "2 done"])
        let many = (0..<40).map { DownloadsPage.Item(id: $0, title: "x", state: "failed") }
        XCTAssertEqual(AccountDownloadsLogic.shown(many, state: "failed").count, 30)
        let q = (0..<40).map { DownloadsPage.Item(id: $0, title: "x", state: "queued") }
        XCTAssertEqual(AccountDownloadsLogic.shown(q, state: "queued").count, 40)
    }

    func testStatusLines() {
        let w = DownloadsPage.Watcher(lastCheck: now - 120_000, next: now + 40_000, checking: false, perCheck: 5, wanted: 12)
        XCTAssertEqual(AccountDownloadsLogic.watcherLine(w, now: now),
                       "Soulseek downloader: last checked 2 min ago • next check in 40 s • 12 albums wanted, 5 searched per check")
        XCTAssertNil(AccountDownloadsLogic.watcherLine(nil, now: now))

        let dl = DownloadsPage.Item(id: 1, title: "T", state: "downloading", total: 12, done: 4, started: now - 300_000)
        XCTAssertEqual(AccountDownloadsLogic.statusLine(dl, watcher: nil, now: now).text, "4 of 12 songs • started 5 min ago")
        XCTAssertEqual(AccountDownloadsLogic.progress(dl)!, 0.33, accuracy: 0.001)
        let torrent = DownloadsPage.Item(id: 1, title: "T", state: "downloading", total: 0, via: "torrent", detail: "40%")
        XCTAssertEqual(AccountDownloadsLogic.statusLine(torrent, watcher: nil, now: now).text, "Torrent • 40%")
        XCTAssertEqual(AccountDownloadsLogic.progress(torrent), 0.03)

        let queued = DownloadsPage.Item(id: 2, title: "T", state: "queued", search: .init(at: now - 60_000, results: 1, outcome: "nomatch"))
        XCTAssertEqual(AccountDownloadsLogic.statusLine(queued, watcher: w, now: now).text,
                       "Searched Soulseek 1 min ago: 1 result, none a complete match for this release • next try in 40 s")
        let matched = DownloadsPage.Item(id: 2, title: "T", state: "queued", search: .init(at: now, outcome: "matched"))
        XCTAssertEqual(AccountDownloadsLogic.statusLine(matched, watcher: w, now: now).text, "Found on Soulseek just now, the download is starting")
        let fresh = DownloadsPage.Item(id: 3, title: "T", state: "queued", requested: now - 120_000)
        XCTAssertEqual(AccountDownloadsLogic.statusLine(fresh, watcher: nil, now: now).text, "Waiting for the downloader to pick it up • requested 2 min ago")
        XCTAssertEqual(AccountDownloadsLogic.statusLine(fresh, watcher: w, now: now).text,
                       "Not searched yet • first search at the next check, in 40 s (12 albums wait, 5 are searched per check, so it can take a few)")
        XCTAssertNil(AccountDownloadsLogic.progress(fresh))

        let stuck = DownloadsPage.Item(id: 4, title: "T", state: "stuck", total: 10, done: 2, progressAt: now - 2 * 3_600_000)
        let st = AccountDownloadsLogic.statusLine(stuck, watcher: nil, now: now)
        XCTAssertEqual(st.text, "No progress for 2 h • 2 of 10 songs")
        XCTAssertTrue(st.warn)
        XCTAssertEqual(AccountDownloadsLogic.action(stuck), .retry)

        let failed = DownloadsPage.Item(id: 5, title: "T", state: "failed", finished: now - 600_000)
        XCTAssertEqual(AccountDownloadsLogic.statusLine(failed, watcher: nil, now: now).text, "Failed • 10 min ago")

        let done = DownloadsPage.Item(id: 6, title: "T", state: "done", done: 1, libraryAlbumId: "al")
        XCTAssertEqual(AccountDownloadsLogic.statusLine(done, watcher: nil, now: now).text, "1 song added")
        XCTAssertEqual(AccountDownloadsLogic.action(done), .play)
        XCTAssertEqual(AccountDownloadsLogic.progress(done), 1)
        let lost = DownloadsPage.Item(id: 7, title: "T", state: "done", done: 3)
        XCTAssertTrue(AccountDownloadsLogic.statusLine(lost, watcher: nil, now: now).warn)
        XCTAssertNil(AccountDownloadsLogic.action(lost))
        XCTAssertEqual(AccountDownloadsLogic.meta(.init(id: 8, title: "T", artist: "A", type: "Album", year: "2020", state: "done")), "A • Album • 2020")
    }
}

@MainActor
final class AccountDownloadsModelTests: XCTestCase {
    override func setUp() async throws { AccountDownloadsModel.resetKept() }

    func testLoadsKeepsAndReportsErrors() async {
        let src = AccountDownloadsFakeSource()
        src.answers[.mine] = DownloadsPage(items: [.init(id: 1, title: "A", state: "queued")])
        let m = AccountDownloadsModel(source: src)
        XCTAssertNil(m.data)
        await m.load()
        XCTAssertEqual(m.data?.items.count, 1)
        m.setScope(.all)
        XCTAssertNil(m.data)
        await m.load()
        XCTAssertEqual(m.error, "lidarr is not configured")
        m.setScope(.mine)
        XCTAssertEqual(m.data?.items.count, 1, "the last answer for a scope shows at once")
        XCTAssertNil(m.error)
    }

    func testAnswerForALeftScopeIsDropped() async {
        let src = AccountDownloadsFakeSource()
        src.answers[.mine] = DownloadsPage(items: [.init(id: 1, title: "mine", state: "queued")])
        src.answers[.all] = DownloadsPage(items: [.init(id: 2, title: "all", state: "queued"), .init(id: 3, title: "b", state: "done")])
        let m = AccountDownloadsModel(source: src)
        src.holdNext = true
        let slow = Task { await m.load() }
        while src.gate == nil { await Task.yield() }
        m.setScope(.all)
        await m.load()
        XCTAssertEqual(m.data?.items.count, 2)
        src.gate?.resume()
        await slow.value
        XCTAssertEqual(m.data?.items.count, 2, "the slow `mine` answer must not render under `all`")
    }

    func testRetry() async {
        let src = AccountDownloadsFakeSource()
        src.answers[.mine] = DownloadsPage(items: [])
        let m = AccountDownloadsModel(source: src)
        let item = DownloadsPage.Item(id: 9, title: "Kid A", state: "failed")
        let ok = await m.retry(item)
        XCTAssertEqual(ok, "Kid A is back in line")
        XCTAssertEqual(src.retried, [9])
        XCTAssertEqual(src.calls, [.mine], "reloads after a retry")
        XCTAssertNil(m.retrying)
        src.failRetry = APIError.http(409, "not failed")
        let bad = await m.retry(item)
        XCTAssertEqual(bad, "Could not retry: not failed")
    }
}
