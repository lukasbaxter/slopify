import XCTest
import SwiftUI
@testable import Slopify

final class SVGPathTests: XCTestCase {
    func testBasicCommands() {
        let p = SVGPath.parse("M2 2h4v4H2z")
        XCTAssertEqual(p.boundingBox, CGRect(x: 2, y: 2, width: 4, height: 4))
        let rel = SVGPath.parse("m1 1 2 0 0 2-2 0z") // implicit lineto after moveto
        XCTAssertEqual(rel.boundingBox, CGRect(x: 1, y: 1, width: 2, height: 2))
    }

    func testPackedNumbersAndArcs() {
        // ".5.5" is two numbers; arc flags may be packed.
        let p = SVGPath.parse("M0 0l.5.5")
        XCTAssertEqual(p.currentPoint, CGPoint(x: 0.5, y: 0.5))
        let circle = SVGPath.parse("M0 8a8 8 0 1 0 16 0a8 8 0 1 0 -16 0z")
        XCTAssertEqual(circle.boundingBox.width, 16, accuracy: 0.05)
        XCTAssertEqual(circle.boundingBox.height, 16, accuracy: 0.05)
        let packed = SVGPath.parse("M8 0a8 8 0 110 16")
        XCTAssertEqual(packed.currentPoint.y, 16, accuracy: 0.001)
    }

    func testEveryIconParsesInsideItsViewBox() {
        for icon in Icon.allCases {
            let spec = icon.spec
            XCTAssertFalse(spec.elements.isEmpty, icon.rawValue)
            for el in spec.elements {
                let b = el.path.boundingBoxOfPath
                XCTAssertFalse(b.isEmpty && b.width == 0 && b.height == 0, "\(icon.rawValue) empty")
                let slack: CGFloat = el.rotate == nil ? 1.5 : 6
                XCTAssertGreaterThanOrEqual(b.minX, -slack, icon.rawValue)
                XCTAssertGreaterThanOrEqual(b.minY, -slack, icon.rawValue)
                XCTAssertLessThanOrEqual(b.maxX, spec.viewBox + slack, icon.rawValue)
                XCTAssertLessThanOrEqual(b.maxY, spec.viewBox + slack, icon.rawValue)
            }
        }
    }

    func testFilledPairs() {
        XCTAssertEqual(Icon.heart.filled, .heartFilled)
        XCTAssertEqual(Icon.homeTab.filled, .homeTabFilled)
        XCTAssertEqual(Icon.plus.filled, .plus)
    }
}

final class QualityTests: XCTestCase {
    func testLabels() {
        XCTAssertEqual(DeliveredFormat.label(Format(codec: "FLAC", lossless: true, bitrate: nil, sampleRate: 44100, bitDepth: 16)), "FLAC 44.1kHz")
        XCTAssertEqual(DeliveredFormat.label(Format(codec: "FLAC", lossless: true, bitrate: nil, sampleRate: 96000, bitDepth: 24)), "FLAC 24-bit 96kHz")
        XCTAssertEqual(DeliveredFormat.label(Format(codec: "AAC", lossless: false, bitrate: 320000, sampleRate: nil, bitDepth: nil)), "AAC 320kbps")
        XCTAssertEqual(DeliveredFormat.label(Format(codec: "MP3", lossless: false, bitrate: nil, sampleRate: nil, bitDepth: nil)), "MP3")
        XCTAssertNil(DeliveredFormat.label(Format(codec: nil, lossless: nil, bitrate: nil, sampleRate: nil, bitDepth: nil)))
    }

    func testDelivered() {
        let flac = Format(codec: "FLAC", lossless: true, bitrate: 1_000_000, sampleRate: 48000, bitDepth: 16)
        XCTAssertEqual(DeliveredFormat.delivered(flac, deviceKind: "bluos"), flac)
        XCTAssertEqual(DeliveredFormat.delivered(flac, deviceKind: "local", mode: .file), flac)
        XCTAssertEqual(DeliveredFormat.label(DeliveredFormat.delivered(flac, deviceKind: "local", profile: "alac")), "ALAC 48kHz")
        XCTAssertEqual(DeliveredFormat.label(DeliveredFormat.delivered(flac, deviceKind: "local", profile: "aac-160")), "AAC 160kbps")
        XCTAssertEqual(DeliveredFormat.label(DeliveredFormat.delivered(flac, deviceKind: "local", mode: .mp3, profile: "aac-96")), "MP3 96kbps")
    }
}

final class MenuTests: XCTestCase {
    func testOfflineSubsetTidiesSeparators() {
        let items: [MenuItem] = [
            MenuItem("Add to queue", offline: true), MenuItem("Add to playlist"), .separator,
            MenuItem("Go to song radio"), .separator, MenuItem("Go to artist", offline: true), MenuItem("Go to album", offline: true),
            .separator, MenuItem("Share"),
        ]
        let off = MenuItem.offlineSubset(items)
        XCTAssertEqual(off.map { $0.kind == .separator ? "-" : $0.label }, ["Add to queue", "-", "Go to artist", "Go to album"])
        XCTAssertEqual(MenuItem.tidy([.separator, MenuItem("a"), .separator, .separator, MenuItem("b"), .separator]).map { $0.kind == .separator ? "-" : $0.label }, ["a", "-", "b"])
    }
}

final class GestureMathTests: XCTestCase {
    func testSheetDismissThresholds() {
        let d = Gestures.sheetDismissDistance
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 101, velocity: 0, distance: d))
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 99, velocity: 0, distance: d))
        XCTAssertTrue(SwipeDismiss.shouldDismiss(along: 41, velocity: 600, distance: d))
        // A slow drag that stops short springs back, however quick it was.
        XCTAssertFalse(SwipeDismiss.shouldDismiss(along: 41, velocity: 50, distance: d))
    }

    func testTopBarFade() {
        typealias S = DetailScaffold<EmptyView>
        XCTAssertEqual(S.progress(scrollTop: 40, heroHeight: 400), 0)
        XCTAssertEqual(S.progress(scrollTop: 40 + 170, heroHeight: 400), 0.5)   // span = 340
        XCTAssertEqual(S.progress(scrollTop: 1000, heroHeight: 400), 1)
        XCTAssertEqual(S.progress(scrollTop: 40 + 60, heroHeight: 100), 0.5)    // span floor 120
        XCTAssertEqual(S.progress(scrollTop: 40 + 80, heroHeight: nil), 0.5)    // no hero: 160
        XCTAssertEqual(S.titleOpacity(0.5), 0)
        XCTAssertEqual(S.titleOpacity(0.75), 0.5)
    }

    func testMarqueeTiming() {
        // dist 60: D = 6 s per direction; holds 25 % at each end.
        XCTAssertEqual(Marquee.offset(at: 0, dist: 60).0, 0)
        XCTAssertEqual(Marquee.offset(at: 1.4, dist: 60).0, 0)
        XCTAssertEqual(Marquee.offset(at: 3, dist: 60).0, -42, accuracy: 0.01)   // halfway: -(60+24)/2
        XCTAssertEqual(Marquee.offset(at: 5, dist: 60).0, -84, accuracy: 0.01)
        XCTAssertEqual(Marquee.offset(at: 9, dist: 60).0, -42, accuracy: 0.01)   // coming back
        XCTAssertFalse(Marquee.offset(at: 0.5, dist: 60).1)
        XCTAssertTrue(Marquee.offset(at: 3, dist: 60).1)
    }

    func testHeroCoverSide() {
        XCTAssertEqual(HeroHeader<EmptyView, EmptyView>.coverSide(width: 393), 250)
        XCTAssertEqual(HeroHeader<EmptyView, EmptyView>.coverSide(width: 375), 220)
        XCTAssertEqual(HeroHeader<EmptyView, EmptyView>.coverSide(width: 280), 216)
    }
}

/// Image requests ask for WebP and are shared while in flight.
final class ImageLoaderTests: XCTestCase {
    final class Stub: URLProtocol {
        nonisolated(unsafe) static var accepts: [String] = []
        nonisolated(unsafe) static var hits = 0
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.accepts.append(request.value(forHTTPHeaderField: "Accept") ?? "")
            Self.hits += 1
            let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
            let r = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png", "Cache-Control": "no-store"])!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: png)
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    func testAcceptHeaderAndMemoryCache() async {
        Stub.accepts = []; Stub.hits = 0
        let loader = ImageLoader(diskBytes: 0, protocolClasses: [Stub.self])
        let url = URL(string: "https://example.invalid/api/art/abc/160.webp")!
        let a = await loader.image(url)
        let b = await loader.image(url)
        XCTAssertNotNil(a); XCTAssertNotNil(b)
        XCTAssertEqual(Stub.accepts.first, "image/webp,image/jpeg")
        XCTAssertEqual(Stub.hits, 1)
        XCTAssertNotNil(loader.cached(url))
    }

    /// The app moving between the server's home and main address must not grey out covers it
    /// already has: the same server's artwork is the same picture at either address.
    func testArtworkSurvivesTheAddressMove() async {
        Stub.hits = 0
        let loader = ImageLoader(diskBytes: 0, protocolClasses: [Stub.self])
        let main = URL(string: "https://music.example.com/api/art/abc/160.webp")!
        let home = URL(string: "http://h.test:8090/api/art/abc/160.webp")!
        let playlist = URL(string: "https://music.example.com/api/image/pl_1?c=aa&size=192")!
        let a = await loader.image(main), b = await loader.image(playlist)
        XCTAssertNotNil(a); XCTAssertNotNil(b)
        XCTAssertNotNil(loader.cached(home), "moved to the home address: the cover is gone until refetched")
        XCTAssertNotNil(loader.cached(URL(string: "http://h.test:8090/api/image/pl_1?c=aa&size=192")!))
        let c = await loader.image(home)
        XCTAssertNotNil(c)
        XCTAssertEqual(Stub.hits, 2, "no refetch after the move")
        // A different picture is still a different picture.
        XCTAssertNil(loader.cached(URL(string: "http://h.test:8090/api/art/abc/320.webp")!))
        XCTAssertNil(loader.cached(URL(string: "http://h.test:8090/api/image/pl_1?c=bb&size=192")!))
        // Pictures from other sites keep their own address.
        XCTAssertNil(loader.cached(URL(string: "https://example.invalid/front.jpg")!))
        _ = await loader.image(URL(string: "https://example.invalid/front.jpg")!)
        XCTAssertNil(loader.cached(URL(string: "https://example.org/front.jpg")!))
    }
}
