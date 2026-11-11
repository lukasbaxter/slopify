import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Pages opened from Your Library pop with a left-to-right swipe anywhere in the top half of
/// the screen while the page is scrolled to the top (owner 11-11, Spotify iOS). Interactive like
/// the edge swipe, because UIKit's own interactive pop runs it:
/// - iOS 26+: UIKit already has a full-width pop (`interactiveContentPopGestureRecognizer`).
///   On the Library stack it is made to wait for a blocker pan that recognizes whenever the
///   rules say no, so it only starts where they say yes. A forwarded pan does not work there:
///   the shared handler ignores recognizers it does not own (checked on iOS 27).
/// - iOS 18-25: a full-width pan forwards to the edge swipe's own handler (SloppySwiper).
/// The system edge swipe is left alone, and Home / Search get nothing.
enum LibrarySwipeBack {
    /// Scroll offset tolerance for "at the top".
    static let topEpsilon: CGFloat = 1

    struct Input: Equatable {
        var isLibraryTab: Bool
        /// The navigation controller's view controller count (root = 1).
        var stackCount: Int
        /// Touch-down point, window coordinates.
        var start: CGPoint
        var screen: CGSize
        /// First movement (translation, or velocity before any).
        var direction: CGPoint
        var scrollAtTop: Bool
        /// The touch landed on a track row: the row queues instead.
        var onTrackRow: Bool
        /// The touch landed in a horizontal shelf that is scrolled away from its start: the shelf scrolls.
        var inScrolledShelf: Bool = false
    }

    static func shouldBegin(_ i: Input) -> Bool {
        i.isLibraryTab && i.stackCount > 1
            && i.start.x >= SwipeToQueue.edgeGuard && i.start.y < i.screen.height / 2
            && SwipeToQueue.isRightward(i.direction)
            && i.scrollAtTop && !i.onTrackRow && !i.inScrolledShelf
    }

    static func isAtTop(offsetY: CGFloat, insetTop: CGFloat) -> Bool { offsetY + insetTop <= topEpsilon }

    /// The edge-swipe recognizer's private target and action (SloppySwiper). Nil when UIKit
    /// changes its internals; the Library stack then keeps only the edge swipe.
    static func popHandler(of pop: UIGestureRecognizer) -> (NSObject, Selector)? {
        guard let targets = pop.value(forKey: "targets") as? [NSObject], let entry = targets.first,
              let target = entry.value(forKey: "target") as? NSObject else { return nil }
        // The entry describes itself as "(action=handleNavigationTransition:, target=<...>)".
        let d = entry.description
        var action = Selector(("handleNavigationTransition:"))
        if let r = d.range(of: "action="), let end = d[r.upperBound...].firstIndex(where: { $0 == "," || $0 == ")" }) {
            action = Selector(String(d[r.upperBound..<end]))
        }
        return target.responds(to: action) ? (target, action) : nil
    }
}

/// The full-width pan; its own delegate so its gate lives as long as the navigation view holds it.
/// `.forward` begins where the swipe may pop (and drives the pop); `.block` begins where it may
/// not, alongside everything else, so the system content pop that waits for it fails there.
final class LibrarySwipeBackPan: UIPanGestureRecognizer, UIGestureRecognizerDelegate {
    enum Mode { case forward, block }
    var mode: Mode = .forward {
        didSet { cancelsTouchesInView = mode == .forward; delaysTouchesEnded = mode == .forward }
    }
    weak var navigation: UINavigationController?
    var isLibraryTab: () -> Bool = { false }
    private weak var touch: UITouch?
    private var startPoint: CGPoint = .zero

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        maximumNumberOfTouches = 1
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if touch == nil, let t = touches.first { touch = t; startPoint = t.location(in: nil) }
    }

    override func reset() {
        super.reset()
        touch = nil
    }

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        mode == .forward ? allowed : !allowed
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        mode == .block
    }

    private var allowed: Bool {
        guard let nav = navigation, let window = nav.view.window, nav.transitionCoordinator == nil else { return false }
        let page = nav.topViewController?.view
        let scroll = page.map { Self.scrollState(at: startPoint, in: $0) } ?? (atTop: true, inShelf: false)
        let t = translation(in: nil)
        let input = LibrarySwipeBack.Input(
            isLibraryTab: isLibraryTab(), stackCount: nav.viewControllers.count, start: startPoint,
            screen: window.bounds.size, direction: t == .zero ? velocity(in: nil) : t,
            scrollAtTop: scroll.atTop, onTrackRow: touch.map(SwipeToQueueTouches.contains) ?? false,
            inScrolledShelf: scroll.inShelf)
        return LibrarySwipeBack.shouldBegin(input)
    }

    /// The page's vertical scroll under the point (the innermost one), and whether the point is
    /// in a horizontal shelf that is not at its start.
    private static func scrollState(at p: CGPoint, in root: UIView) -> (atTop: Bool, inShelf: Bool) {
        var vertical: UIScrollView?
        var shelf = false
        func visit(_ v: UIView) {
            guard !v.isHidden, v.alpha > 0.01 else { return }
            if let s = v as? UIScrollView, s.convert(s.bounds, to: nil).contains(p) {
                if s.contentSize.width > s.bounds.width + 1 {
                    if s.contentOffset.x > -s.adjustedContentInset.left + LibrarySwipeBack.topEpsilon { shelf = true }
                } else {
                    vertical = s
                }
            }
            v.subviews.forEach(visit)
        }
        visit(root)
        let atTop = vertical.map { LibrarySwipeBack.isAtTop(offsetY: $0.contentOffset.y, insetTop: $0.adjustedContentInset.top) } ?? true
        return (atTop, shelf)
    }
}

/// Put in the Library root's background: finds the stack's navigation controller and adds the
/// pan once.
struct LibrarySwipeBackInstaller: UIViewRepresentable {
    var isLibraryTab: () -> Bool

    func makeUIView(context: Context) -> Probe { Probe(isLibraryTab: isLibraryTab) }
    func updateUIView(_ v: Probe, context: Context) { v.isLibraryTab = isLibraryTab; v.install() }

    final class Probe: UIView {
        var isLibraryTab: () -> Bool
        init(isLibraryTab: @escaping () -> Bool) {
            self.isLibraryTab = isLibraryTab
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); install() }

        func install() {
            guard window != nil, let nav = navigation else { return }
            if let pan = nav.view.gestureRecognizers?.first(where: { $0 is LibrarySwipeBackPan }) as? LibrarySwipeBackPan {
                pan.isLibraryTab = isLibraryTab
                return
            }
            let pan: LibrarySwipeBackPan
            if #available(iOS 26.0, *), let content = nav.interactiveContentPopGestureRecognizer {
                pan = LibrarySwipeBackPan(target: nil, action: nil)
                pan.mode = .block
                content.require(toFail: pan)
            } else {
                guard let pop = nav.interactivePopGestureRecognizer, let (target, action) = LibrarySwipeBack.popHandler(of: pop) else { return }
                pan = LibrarySwipeBackPan(target: target, action: action)
            }
            pan.navigation = nav
            pan.isLibraryTab = isLibraryTab
            nav.view.addGestureRecognizer(pan)
        }

        private var navigation: UINavigationController? {
            var r: UIResponder? = self
            while let x = r {
                if let vc = x as? UIViewController, let n = vc.navigationController ?? (vc as? UINavigationController) { return n }
                r = x.next
            }
            return nil
        }
    }
}
