import Foundation

/// SlopifyTests/Design/ColorFixtures.json: outputs of the web's own JS on fixed inputs
/// (ios/tools/color-fixtures.mjs).
struct ColorFixtures: Decodable {
    struct Clamp: Decodable { var `in`: [Double]; var out: [Double] }
    struct Hero: Decodable { var `in`: [Double]; var css: String; var hex: String }
    struct PhoneHero: Decodable { var `in`: String; var hex: String }
    struct Blur: Decodable { var `in`: String; var out: [Double]? }
    struct ThemeCase: Decodable {
        var name: String
        var theme: [String: String]
        var vars: [String: String]
        var colorScheme: String
        var light: Bool
    }
    var sets: [String: [UInt8]]
    var vibrant: [String: [Double]?]
    var palette: [String: [String]?]
    var clamp: [Clamp]
    var hero: [Hero]
    var phoneHero: [PhoneHero]
    var blurhash: [Blur]
    var themes: [ThemeCase]

    static let shared: ColorFixtures = {
        let url = Bundle(for: BundleToken.self).url(forResource: "ColorFixtures", withExtension: "json")!
        return try! JSONDecoder().decode(ColorFixtures.self, from: Data(contentsOf: url))
    }()
}

final class BundleToken {}
