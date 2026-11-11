import UIKit

/// The system share sheet over whatever is on top. Shared by every feature.
/// With no window to present from, the link is copied and a toast says so.
@MainActor
enum ShareSheet {
    static func present(url: URL, title: String) {
        present(items: [Item(url: url, title: title)], fallbackURL: url)
    }

    static func present(items: [Any], fallbackURL: URL? = nil) {
        guard let top = topController() else {
            if let fallbackURL {
                UIPasteboard.general.url = fallbackURL
                ToastCenter.shared.show(L("Link copied"))
            }
            return
        }
        let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
        vc.popoverPresentationController?.sourceView = top.view
        top.present(vc, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var top = window?.rootViewController
        while let p = top?.presentedViewController { top = p }
        return top
    }

    private final class Item: NSObject, UIActivityItemSource {
        let url: URL, title: String
        init(url: URL, title: String) { self.url = url; self.title = title }
        func activityViewControllerPlaceholderItem(_ c: UIActivityViewController) -> Any { url }
        func activityViewController(_ c: UIActivityViewController, itemForActivityType t: UIActivity.ActivityType?) -> Any? { url }
        func activityViewController(_ c: UIActivityViewController, subjectForActivityType t: UIActivity.ActivityType?) -> String { title }
    }
}
