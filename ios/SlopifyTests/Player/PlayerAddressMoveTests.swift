import AVFoundation
import XCTest
@testable import Slopify

/// A backend whose address can move, like APIClient between the home and the main address.
@MainActor
private final class MovingBackend: PlayerBackend {
    var base: URL
    init(base: URL) { self.base = base }
    var token: String? = "tok"
    func tracks(ids: [String]) async throws -> [Track] { [] }
    func mix(_ id: String, limit: Int?, mode: String?) async throws -> Mix { Mix(items: [], from: nil, day: nil) }
    func artist(_ id: String) async throws -> ArtistDetail { throw APIError.http(404, "no") }
    func warm(ids: [String], profile: String, norm: String?) async throws {}
    func postPlay(trackId: String, at: Double?, client: String) async throws {}
    func hlsURL(trackId: String, max: String, norm: String?) -> URL { base.appendingPathComponent("\(trackId).wav") }
    func imageURL(id: String, size: Int, banner: Bool, bust: String?) -> URL { base.appendingPathComponent("img-\(id)") }
    func imageData(id: String, size: Int) async -> Data? { nil }
    func prewarm(master: URL) async {}
}

/// The real AVFoundation output: a song whose address is lost while it plays (left home, the
/// app moved to the main address) is retried at the address in use now, not the dead one.
@MainActor
final class PlayerAddressMoveTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("address-move-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("now"), withIntermediateDirectories: true)
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: root) }

    /// `seconds` of silence, 16-bit mono PCM.
    private func writeSilence(_ url: URL, seconds: Int) throws {
        let rate: UInt32 = 8000, bytes = UInt32(seconds) * rate * 2
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes); d.append(Data(count: Int(bytes)))
        try d.write(to: url)
    }

    func testRetryAfterTheAddressMovedUsesTheNewAddress() async throws {
        let lost = root.appendingPathComponent("lost", isDirectory: true)      // never answers
        let now = root.appendingPathComponent("now", isDirectory: true)
        try writeSilence(now.appendingPathComponent("a.wav"), seconds: 20)
        let backend = MovingBackend(base: lost)
        let p = Player()
        p.isTablet = false
        Player.headStartMs = 0
        p.configure(backend: backend, link: FakeLink(), prefs: { [:] }, engine: AVAudioOutput(), audioSession: nil, lockScreen: nil, store: nil)
        p.play([makeTrack("a", ms: 20_000)])
        // The address in use moves while the song is starting on the old one.
        backend.base = now
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline, p.isLoading || !p.isPlaying { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertTrue(p.isPlaying, "playback gave up")
        XCTAssertFalse(p.isLoading, "the retry went back to the lost address: still no sound")
        XCTAssertNil(p.error)
    }
}
