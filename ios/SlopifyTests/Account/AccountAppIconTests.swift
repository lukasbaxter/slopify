import XCTest
import UIKit
import SwiftUI
@testable import Slopify

final class AccountAppIconTests: XCTestCase {
    func testDefaultFirstAndUnknownReadsAsDefault() {
        XCTAssertNil(AccountAppIcon.all.first?.id)
        XCTAssertEqual(AccountAppIcon.choice(for: nil), AccountAppIcon.all[0])
        XCTAssertEqual(AccountAppIcon.choice(for: "AppIcon-Gone"), AccountAppIcon.all[0])
        XCTAssertEqual(AccountAppIcon.choice(for: "AppIcon-Sunset").name, "Sunset")
        XCTAssertEqual(Set(AccountAppIcon.all.map(\.preview)).count, AccountAppIcon.all.count)
    }

    /// Every choice must ship: its preview image, and (alternates) an icon iOS knows by that name.
    func testEveryIconIsInTheBuild() throws {
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        let alternates = icons?["CFBundleAlternateIcons"] as? [String: Any] ?? [:]
        for c in AccountAppIcon.all {
            XCTAssertNotNil(UIImage(named: c.preview), "preview \(c.preview)")
            if let id = c.id { XCTAssertNotNil(alternates[id], "alternate icon \(id)") }
        }
    }
}

@MainActor
final class AccountAppIconPickerLayoutTests: XCTestCase {
    /// 11-11: the picker inside the bottom sheet showed no icons. The sheet offers its content
    /// only the height it measured last (0 at first), so the picker must keep its own height
    /// when offered almost none, not shrink into it the way a ScrollView does.
    func testPickerKeepsItsHeightWhenOfferedLittle() {
        let host = UIHostingController(rootView: AccountAppIconPicker())
        let size = host.sizeThatFits(in: CGSize(width: 390, height: 40))
        XCTAssertGreaterThan(size.height, 400, "\(size)")
    }
}
