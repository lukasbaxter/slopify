import XCTest
@testable import Slopify

final class LocalizerTests: XCTestCase {
    func testPlaceholders() {
        XCTAssertEqual(Localizer.fill("Added to {name}", ["name": "Road trip"]), "Added to Road trip")
        XCTAssertEqual(Localizer.fill("{n} of {total}", ["n": 3]), "3 of {total}") // missing stays literal
        XCTAssertEqual(Localizer.fill("a {not a var} b", ["not": 1]), "a {not a var} b")
        XCTAssertEqual(Localizer.fill("no vars", [:]), "no vars")
    }

    func testMatchMirrorsI18nJS() {
        XCTAssertEqual(Localizer.match("de-AT"), "de")
        XCTAssertEqual(Localizer.match("pt"), "pt-BR")
        XCTAssertEqual(Localizer.match("pt_PT"), "pt-BR")
        XCTAssertEqual(Localizer.match("zh-Hant-TW"), "zh-TW")
        XCTAssertEqual(Localizer.match("zh-HK"), "zh-TW")
        XCTAssertEqual(Localizer.match("zh"), "zh-CN")
        XCTAssertEqual(Localizer.match("no"), "nb")
        XCTAssertEqual(Localizer.match("nn-NO"), "nb")
        XCTAssertEqual(Localizer.match("EN-us"), "en")
        XCTAssertNil(Localizer.match("auto"))
        XCTAssertNil(Localizer.match("xx"))
        XCTAssertNil(Localizer.match(""))
    }

    func testResolveOrder() {
        XCTAssertEqual(Localizer.resolve(user: "fr", server: "de", device: ["ja"]), "fr")
        XCTAssertEqual(Localizer.resolve(user: "", server: "de", device: ["ja"]), "de")
        XCTAssertEqual(Localizer.resolve(user: nil, server: "auto", device: ["xx", "ja-JP"]), "ja")
        XCTAssertEqual(Localizer.resolve(user: nil, server: nil, device: ["xx"]), "en")
    }

    func testBundledLocalesLoadAndSwitchLive() {
        XCTAssertEqual(Localizer.languages.count, 22)
        for (code, _) in Localizer.languages where code != "en" {
            XCTAssertFalse(Localizer.load(code, bundle: .main).isEmpty, "\(code).json missing from the app bundle")
        }
        let defaults = UserDefaults(suiteName: "LocalizerTests")!
        defaults.removePersistentDomain(forName: "LocalizerTests")
        let l = Localizer(defaults: defaults, bundle: .main, preferred: { ["en"] })
        XCTAssertEqual(l.t("Add to queue"), "Add to queue")
        l.setUserPick("de")
        XCTAssertEqual(l.language, "de")
        XCTAssertNotEqual(l.t("Add to queue"), "Add to queue")
        XCTAssertEqual(l.t("A key nobody has"), "A key nobody has")
        l.setUserPick("")
        XCTAssertEqual(l.language, "en")
    }

    func testTranslationsKeepPlaceholders() {
        let de = Localizer.load("de", bundle: .main)
        guard let s = de["Added to {name}"] else { return XCTFail("missing key") }
        XCTAssertTrue(s.contains("{name}"))
    }

    func testBoldMarkup() {
        let a = boldMarkup("<b>Tap along to the beat</b> for 8 seconds.")
        XCTAssertEqual(String(a.characters), "Tap along to the beat for 8 seconds.")
        let runs = a.runs.map { $0.inlinePresentationIntent }
        XCTAssertEqual(runs.first, .stronglyEmphasized)
    }
}
