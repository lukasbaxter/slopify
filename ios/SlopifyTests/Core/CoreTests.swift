import XCTest
@testable import Slopify

final class AddressTests: XCTestCase {
    // Same cases as web/src/api/address.js
    func testGuessesSchemeAndTriesTheOther() {
        XCTAssertEqual(Address.candidates("music.example.com").map(\.absoluteString), ["https://music.example.com", "http://music.example.com"])
        XCTAssertEqual(Address.candidates("192.168.1.85:8080").map(\.absoluteString), ["http://192.168.1.85:8080", "https://192.168.1.85:8080"])
        XCTAssertEqual(Address.candidates("debster.local").first?.absoluteString, "http://debster.local")
        XCTAssertEqual(Address.candidates("server").first?.absoluteString, "http://server")
    }
    func testTypedSchemeIsKeptAndNormalised() {
        XCTAssertEqual(Address.candidates(" HTTPS://Music.Example.com:443/ ").map(\.absoluteString), ["https://music.example.com"])
        XCTAssertEqual(Address.candidates("http://h.example.com:80/sub/").map(\.absoluteString), ["http://h.example.com/sub"])
    }
    func testRejectsJunk() {
        XCTAssertEqual(Address.candidates(""), [])
        XCTAssertEqual(Address.candidates("ftp://x.com"), [])
        XCTAssertEqual(Address.candidates("-bad.com"), [])
    }
    func testLANOnly() {
        XCTAssertTrue(Address.isLANOnly(URL(string: "http://192.168.1.85:8080")!))
        XCTAssertTrue(Address.isLANOnly(URL(string: "http://debster.local")!))
        XCTAssertFalse(Address.isLANOnly(URL(string: "http://100.64.1.2")!)) // Tailscale
        XCTAssertFalse(Address.isLANOnly(URL(string: "https://music.example.com")!))
    }
}

final class HomeProofTests: XCTestCase {
    // Expected value from Node: createHmac('sha256', Buffer.from(key,'hex')).update(nonce).digest('hex')
    let key = "9c1e" + String(repeating: "ab", count: 30)
    let nonce = "00112233445566778899aabbccddeeff"
    let proof = "45f6ad170a57486a84d2451f10554db3488f0d95776923bcef656ad681bda23b"

    func testMatchesServerHMAC() {
        XCTAssertEqual(HomeProof.expected(keyHex: key, nonce: nonce), proof)
        XCTAssertTrue(HomeProof.verify(keyHex: key, nonce: nonce, proof: proof.uppercased()))
        XCTAssertFalse(HomeProof.verify(keyHex: key, nonce: nonce, proof: String(proof.dropLast()) + "0"))
        XCTAssertFalse(HomeProof.verify(keyHex: "zz", nonce: nonce, proof: proof))
    }
    func testNonceShape() {
        XCTAssertNotNil(HomeProof.nonce().range(of: "^[0-9a-f]{32}$", options: .regularExpression))
    }
}

final class ModelDecodingTests: XCTestCase {
    // JSON from docs/API.md §5.1
    func testTrack() throws {
        let json = #"{"id":"0f6c1a5e9b2d4c3a8e7f6a5b4c3d2e1f","title":"Paranoid Android","artist":"Radiohead","artists":["Radiohead"],"artistIds":["a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4"],"albumId":"1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d","album":"OK Computer","albumArtist":"Radiohead","trackNo":2,"discNo":1,"year":1997,"genres":["Alternative Rock"],"durationMs":383000,"codec":"FLAC","bitrate":1011000,"cover":"5f1d","format":{"codec":"FLAC","lossless":true,"bitrate":1011000,"sampleRate":44100,"bitDepth":16},"gain":{"track":-6.3,"album":-5.8},"identity":{"state":"matched","score":0.97},"addedAt":1760000000000}"#
        let t = try JSONDecoder().decode(Track.self, from: Data(json.utf8))
        XCTAssertEqual(t.duration, 383)
        XCTAssertEqual(t.gain?.album, -5.8)
        XCTAssertEqual(t.artistCredits.first?.id, "a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4")
        let q = QueueItem(t)
        XCTAssertEqual(q.RunTimeTicks, 3_830_000_000)
    }
    func testAlbumDetailFlattened() throws {
        let json = #"{"id":"a","name":"OK Computer","artist":"Radiohead","artistId":"b","year":1997,"trackCount":0,"durationMs":0,"cover":null,"addedAt":1,"tracks":[]}"#
        let d = try JSONDecoder().decode(AlbumDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.album.name, "OK Computer")
        XCTAssertEqual(d.tracks.count, 0)
    }
    func testPrefsKeepUnknownKeys() throws {
        let json = ##"{"theme":{"accent":"#1ed760"},"normalize":false,"weird":[1,"x",null]}"##
        let p = try JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))
        XCTAssertEqual(p["theme"]?["accent"]?.string, "#1ed760")
        XCTAssertEqual(p["normalize"]?.bool, false)
        let back = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(p))
        XCTAssertEqual(back, p)
    }
}

@MainActor
final class APIClientURLTests: XCTestCase {
    func testMediaURLsCarryToken() {
        let api = APIClient(baseURL: URL(string: "https://m.example.com")!, token: "T")
        XCTAssertEqual(api.hlsURL(trackId: "x", max: "aac-160", norm: "track").absoluteString,
                       "https://m.example.com/api/stream/x/hls/master.m3u8?max=aac-160&norm=track&token=T")
        XCTAssertEqual(api.hlsURL(trackId: "x", max: "alac", norm: "track").absoluteString,
                       "https://m.example.com/api/stream/x/hls/master.m3u8?max=alac&token=T")
        XCTAssertEqual(api.artURL(hash: "h", size: 200).absoluteString, "https://m.example.com/api/art/h/320.webp")
        XCTAssertEqual(api.webSocketURL.absoluteString, "wss://m.example.com/api/ws")
    }
}
