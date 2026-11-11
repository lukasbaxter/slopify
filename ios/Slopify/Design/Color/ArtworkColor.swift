import UIKit
import CoreGraphics

/// Cover colours the way the web picks them (api/colors.js), cached per image URL in memory and
/// on disk. Every call is safe from any task; results are nil when the image fails.
///
/// - `vibrant`: the raw prominent colour (now playing `--np`).
/// - `mini`: `clampLightness(vibrant)` (mini player card, UI.md 3.1.1).
/// - `hero`: `heroTint(vibrant)` (detail page `--hero`, UI.md 6.3.1).
/// - `palette`: three visualizer stops (colors.js `paletteColors`).
actor ArtworkColor {
    static let shared = ArtworkColor()

    private let loader: ImageLoader
    private var memo: [String: RGB?] = [:]
    private var inflight: [String: Task<RGB?, Never>] = [:]
    private var disk: [String: [Int]] = [:]
    private var dirty = false
    private let file: URL

    init(loader: ImageLoader = .shared, file: URL? = nil) {
        self.loader = loader
        self.file = file ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("artwork-colors.json")
        if let d = try? Data(contentsOf: self.file), let m = try? JSONDecoder().decode([String: [Int]].self, from: d) { disk = m }
    }

    func vibrant(_ url: URL?) async -> RGB? {
        guard let url else { return nil }
        let k = url.absoluteString
        if let m = memo[k] { return m }
        if let c = disk[k] { let rgb = c.count == 3 ? RGB(Double(c[0]), Double(c[1]), Double(c[2])) : nil; memo[k] = rgb; return rgb }
        if let t = inflight[k] { return await t.value }
        let loader = loader
        let t = Task<RGB?, Never> {
            guard let data = await loader.data(url), let px = Self.pixels(data, side: 40) else { return nil }
            return ColorMath.vibrant(px)
        }
        inflight[k] = t
        let rgb = await t.value
        inflight[k] = nil
        memo[k] = rgb
        // Only remember successes on disk: a failed fetch may work next launch.
        if let rgb { disk[k] = rgb.ints; scheduleSave() }
        return rgb
    }

    func mini(_ url: URL?) async -> RGB? { await vibrant(url).map { ColorMath.clampLightness($0) } }
    func hero(_ url: URL?) async -> RGB? { await vibrant(url).map(ColorMath.heroTint) }

    func palette(_ url: URL?) async -> [RGB]? {
        guard let url, let data = await loader.data(url), let px = Self.pixels(data, side: 48) else { return nil }
        return ColorMath.palette(px)
    }

    private func scheduleSave() {
        guard !dirty else { return }
        dirty = true
        Task { try? await Task.sleep(nanoseconds: 2_000_000_000); self.save() }
    }

    private func save() {
        dirty = false
        if disk.count > 5000 { disk = Dictionary(uniqueKeysWithValues: disk.prefix(4000).map { ($0.key, $0.value) }) }
        if let d = try? JSONEncoder().encode(disk) { try? d.write(to: file, options: .atomic) }
    }

    /// The image drawn into a side x side sRGB canvas, RGBA bytes (canvas `drawImage` + `getImageData`).
    static func pixels(_ data: Data, side: Int) -> [UInt8]? {
        guard let img = UIImage(data: data)?.cgImage else { return nil }
        return pixels(img, side: side)
    }

    static func pixels(_ img: CGImage, side: Int) -> [UInt8]? {
        var buf = [UInt8](repeating: 0, count: side * side * 4)
        let ok = buf.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        return ok ? buf : nil
    }
}
