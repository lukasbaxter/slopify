import XCTest
import UIKit
@testable import Slopify

/// The colour maths must give the same numbers as web/src/api/colors.js and the JSX helpers.
final class ArtworkColorTests: XCTestCase {
    let fx = ColorFixtures.shared

    private func rgb(_ a: [Double]) -> [Int] { a.map { Int($0) } }

    func testVibrantMatchesJS() {
        XCTAssertEqual(fx.vibrant.count, 6)
        for (name, expected) in fx.vibrant {
            let got = ColorMath.vibrant(fx.sets[name]!)
            XCTAssertEqual(got?.ints, expected.map(rgb), name)
        }
    }

    func testPaletteMatchesJS() {
        for (name, expected) in fx.palette {
            let px40 = fx.sets[name]!
            let px48 = (0..<(48 * 48 * 4)).map { px40[$0 % px40.count] }
            let got = ColorMath.palette(px48)?.map { "rgb(\($0.ints.map(String.init).joined(separator: ",")))" }
            XCTAssertEqual(got, expected, name)
        }
    }

    func testClampLightnessMatchesPlayerJSX() {
        for c in fx.clamp {
            let got = ColorMath.clampLightness(RGB(c.in[0], c.in[1], c.in[2]))
            XCTAssertEqual(got.ints, rgb(c.out), "\(c.in)")
        }
    }

    func testHeroTintMatchesLibraryJSX() {
        for h in fx.hero {
            XCTAssertEqual(ColorMath.heroTint(RGB(h.in[0], h.in[1], h.in[2])).hex, h.hex, h.css)
        }
    }

    func testPhoneHeroMatchesUITable() {
        XCTAssertEqual(fx.phoneHero.count, 10)
        for p in fx.phoneHero { XCTAssertEqual(ColorMath.phoneHero(p.in)?.hex, p.hex, p.in) }
        XCTAssertNil(ColorMath.phoneHero("nope"))
    }

    func testBlurhashAverage() {
        for b in fx.blurhash { XCTAssertEqual(ColorMath.blurhashAverage(b.in)?.ints, b.out.map(rgb), b.in) }
    }

    func testDetailHeroPrecedence() {
        let sampled = RGB(200, 30, 40)
        XCTAssertEqual(ColorMath.detailHero(mixColor: "#e8115b", sampled: sampled).hex, "#601b33")
        XCTAssertEqual(ColorMath.detailHero(sampled: sampled).hex, "#601b1f")
        XCTAssertEqual(ColorMath.detailHero(isLiked: true).hex, "#302457")
        XCTAssertEqual(ColorMath.detailHero(sampled: sampled, isArtist: true).hex, "#601b1f")
        XCTAssertEqual(ColorMath.detailHero().hex, "#3d3c3c")
    }

    /// Sampling a real bitmap: a solid red cover comes back as that red.
    func testPixelsFromImage() {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 120)).image { ctx in
            UIColor(red: 200 / 255, green: 30 / 255, blue: 40 / 255, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 120))
        }
        let px = ArtworkColor.pixels(img.pngData()!, side: 40)!
        XCTAssertEqual(px.count, 40 * 40 * 4)
        let v = ColorMath.vibrant(px)!
        XCTAssertEqual(v.r, 200, accuracy: 2); XCTAssertEqual(v.g, 30, accuracy: 2); XCTAssertEqual(v.b, 40, accuracy: 2)
    }
}
