import CarPlay
import UIKit

/// List images for CarPlay: fetched through the app's ImageLoader (same disk cache as the phone),
/// downscaled to CPListItem.maximumImageSize at the car screen's scale, and set once ready.
/// Templates are built with a symbol placeholder and never wait for a picture.
@MainActor
final class CarPlayArtwork {
    private let scale: CGFloat
    private let small = NSCache<NSURL, UIImage>()

    init(scale: CGFloat) {
        self.scale = max(1, scale)
        small.countLimit = 400
    }

    static func placeholder(_ g: CarPlayLogic.Glyph) -> UIImage? {
        let name = switch g {
        case .liked: "heart.fill"
        case .playlist: "music.note.list"
        case .album: "square.stack"
        case .artist: "music.microphone"
        case .mix: "sparkles"
        case .song: "music.note"
        case .downloaded: "arrow.down.circle"
        }
        return UIImage(systemName: name)
    }

    /// Already downscaled (no I/O).
    func cached(_ src: CoverSource?, api: APIClient) -> UIImage? {
        guard let url = url(src, api: api) else { return nil }
        return small.object(forKey: url as NSURL)
    }

    /// Loads in the background and hands the picture to the item.
    func load(_ src: CoverSource?, api: APIClient, into item: CPListItem) {
        guard let url = url(src, api: api) else { return }
        if let hit = small.object(forKey: url as NSURL) { item.setImage(hit); return }
        let target = CPListItem.maximumImageSize, scale = scale
        Task { [weak self, weak item] in
            guard let img = await ImageLoader.shared.image(url) else { return }
            let fitted = await Task.detached(priority: .utility) { Self.fit(img, to: target, scale: scale) }.value
            guard let self else { return }
            self.small.setObject(fitted, forKey: url as NSURL)
            item?.setImage(fitted)
        }
    }

    private func url(_ src: CoverSource?, api: APIClient) -> URL? {
        src?.url(api, size: CarPlayLogic.imagePixels(CPListItem.maximumImageSize, scale: scale))
    }

    /// Aspect-fill into the list image box.
    nonisolated private static func fit(_ img: UIImage, to size: CGSize, scale: CGFloat) -> UIImage {
        guard size.width > 0, size.height > 0, img.size.width > 0, img.size.height > 0 else { return img }
        let f = UIGraphicsImageRendererFormat()
        f.scale = scale
        f.opaque = false
        let k = max(size.width / img.size.width, size.height / img.size.height)
        let drawn = CGSize(width: img.size.width * k, height: img.size.height * k)
        let origin = CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2)
        return UIGraphicsImageRenderer(size: size, format: f).image { _ in img.draw(in: CGRect(origin: origin, size: drawn)) }
    }
}
