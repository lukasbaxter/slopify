import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Swipe right goes back (owner 11-12): on every pushed page of every tab, from anywhere on the
/// page, scrolled or not. On a tab's root page the same swipe opens the account drawer (Spotify
/// iOS). Interactive like the edge swipe, because UIKit's own interactive pop runs it:
/// - iOS 26+: UIKit already has a full-width pop (`interactiveContentPopGestureRecognizer`).
///   It is made to wait for a blocker pan that recognizes whenever the rules say no, so it only
///   starts where they say yes. A forwarded pan does not work there: the shared handler ignores
///   recognizers it does not own (checked on iOS 27).
/// - iOS 18-25: a full-width pan forwards to the edge swipe's own handler (SloppySwiper).
/// - Backstop: UIKit's content pop declines some starts (a shelf at its start, the top bar). Where
///   the rules say back and no pop ran, letting go past 80 pt (or a flick) pops without the drag.
/// Left alone: the system edge swipe, track rows (they queue), drags a view claims
/// (`claimsHorizontalSwipes`, e.g. chart scrubbing) and shelves scrolled away from their start.
enum SwipeBack {
    enum Action: Equatable { case back, drawer }

    struct Input: Equatable {
        var isActiveTab: Bool
        /// The navigation controller's view controller count (root = 1).
        var stackCount: Int
        /// Touch-down point, window coordinates.
        var start: CGPoint
        /// First movement (translation, or velocity before any).
        var direction: CGPoint
        /// The touch landed on a track row or a view that claims horizontal drags.
        var claimed: Bool
        /// The touch landed in a horizontal shelf that is scrolled away from its start: the shelf scrolls.
        var inScrolledShelf: Bool = false
        /// A sheet, now playing or the drawer is over the page.
        var covered: Bool = false
        /// Seconds the finger rested before moving: past the menu press it is a press-and-drag.
        var heldFor: TimeInterval = 0
    }

    /// The backstop pops: past 80 pt, or a rightward flick past 30 pt.
    static func backstopPops(dx: CGFloat, vx: CGFloat) -> Bool {
        dx > 80 || (dx > 30 && vx > Gestures.flickVelocity)
    }

    static func action(_ i: Input) -> Action? {
        guard i.isActiveTab, !i.covered, i.heldFor < Gestures.longPressDuration, SwipeToQueue.isRightward(i.direction),
              !i.claimed, !i.inScrolledShelf else { return nil }
        if i.stackCount > 1 { return i.start.x >= SwipeToQueue.edgeGuard ? .back : nil }
        return i.stackCount == 1 ? .drawer : nil
    }

    /// Whether the point is in a horizontal scroll view that is not at its start.
    @MainActor static func inScrolledShelf(at p: CGPoint, in window: UIWindow) -> Bool {
        var v = window.hitTest(p, with: nil)
        while let x = v {
            if let s = x as? UIScrollView, s.contentSize.width > s.bounds.width + 1,
               s.contentOffset.x > -s.adjustedContentInset.left + SwipeDismiss.topEpsilon { return true }
            v = x.superview
        }
        return false
    }

    /// The edge-swipe recognizer's private target and action (SloppySwiper). Nil when UIKit
    /// changes its internals; the stack then keeps only the edge swipe.
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

/// Touches that landed on something with its own horizontal drag (track rows, chart scrubbing),
/// so the back swipe leaves them to it.
@MainActor
enum HorizontalTouchClaims {
    private static let touches = NSHashTable<UITouch>.weakObjects()
    static func add(_ t: UITouch) { touches.add(t) }
    static func remove(_ t: UITouch) { touches.remove(t) }
    static func contains(_ t: UITouch) -> Bool { touches.contains(t) }
}

/// The full-width pan on a tab's navigation view. `.forward` begins where the swipe may pop (and
/// drives the pop); `.block` begins where it may not, alongside everything else, so the system
/// content pop that waits for it fails there; `.drawer` begins on the root page and opens the drawer;
/// `.backstop` begins where it may pop, alongside everything, and pops on release if nothing else did.
final class SwipeBackPan: UIPanGestureRecognizer, UIGestureRecognizerDelegate {
    enum Mode { case forward, block, drawer, backstop }
    let mode: Mode
    weak var navigation: UINavigationController?
    var isActiveTab: () -> Bool = { false }
    var isCovered: () -> Bool = { false }
    var openDrawer: () -> Void = {}
    var goBack: () -> Void = {}
    private weak var touch: UITouch?
    private var stackAtBegin = 0
    private var transitionSeen = false
    private var startPoint: CGPoint = .zero
    private var downAt: TimeInterval = 0

    init(mode: Mode, target: Any?, action: Selector?) {
        self.mode = mode
        super.init(target: target, action: action)
        maximumNumberOfTouches = 1
        delegate = self
        cancelsTouchesInView = mode == .forward || mode == .drawer
        delaysTouchesEnded = mode == .forward
        if mode == .drawer || mode == .backstop { addTarget(self, action: #selector(fire)) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if touch == nil, let t = touches.first { touch = t; startPoint = t.location(in: nil); downAt = t.timestamp }
    }

    override func reset() {
        super.reset()
        touch = nil
    }

    @objc private func fire() {
        if mode == .drawer { if state == .began { openDrawer() }; return }
        guard let nav = navigation else { return }
        switch state {
        case .began:
            stackAtBegin = nav.viewControllers.count
            transitionSeen = nav.transitionCoordinator != nil
        case .changed:
            if nav.transitionCoordinator != nil { transitionSeen = true }
        case .ended:
            let ranPop = transitionSeen || nav.transitionCoordinator != nil || nav.viewControllers.count != stackAtBegin
            if !ranPop, SwipeBack.backstopPops(dx: translation(in: nil).x, vx: velocity(in: nil).x) { goBack() }
        default: break
        }
    }

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        let a = decided
        switch mode {
        case .forward: return a == .back
        case .block: return a != .back
        case .drawer: return a == .drawer
        case .backstop: return a == .back
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        switch mode {
        case .block: return true
        // Alongside the pop it backs up, scrolling and the other pans; not the page's taps, so the
        // button a back swipe started on fails instead of firing as the finger lifts over it.
        case .backstop: return other is SwipeBackPan || other.view is UIScrollView || other === navigation?.interactivePopGestureRecognizer
            || isContentPop(other)
        default: return false
        }
    }

    private func isContentPop(_ g: UIGestureRecognizer) -> Bool {
        if #available(iOS 26.0, *) { return g === navigation?.interactiveContentPopGestureRecognizer }
        return false
    }

    private var decided: SwipeBack.Action? {
        guard let nav = navigation, let window = nav.view.window, nav.transitionCoordinator == nil else { return nil }
        let t = translation(in: nil)
        return SwipeBack.action(SwipeBack.Input(
            isActiveTab: isActiveTab(), stackCount: nav.viewControllers.count, start: startPoint,
            direction: t == .zero ? velocity(in: nil) : t,
            claimed: touch.map(HorizontalTouchClaims.contains) ?? false,
            inScrolledShelf: SwipeBack.inScrolledShelf(at: startPoint, in: window), covered: isCovered(),
            heldFor: ProcessInfo.processInfo.systemUptime - downAt))
    }
}

/// Put in a tab root's background: finds the stack's navigation controller and adds the pans once.
struct SwipeBackInstaller: UIViewRepresentable {
    var isActiveTab: () -> Bool
    var isCovered: () -> Bool
    var openDrawer: () -> Void
    var goBack: () -> Void

    func makeUIView(context: Context) -> Probe { Probe(self) }
    func updateUIView(_ v: Probe, context: Context) { v.config = self; v.install() }

    final class Probe: UIView {
        var config: SwipeBackInstaller
        init(_ config: SwipeBackInstaller) {
            self.config = config
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); install() }

        func install() {
            guard window != nil, let nav = navigation else { return }
            var pans = nav.view.gestureRecognizers?.compactMap { $0 as? SwipeBackPan } ?? []
            if pans.isEmpty {
                if #available(iOS 26.0, *), let content = nav.interactiveContentPopGestureRecognizer {
                    let block = SwipeBackPan(mode: .block, target: nil, action: nil)
                    content.require(toFail: block)
                    pans.append(block)
                    pans.append(SwipeBackPan(mode: .backstop, target: nil, action: nil))
                } else if let pop = nav.interactivePopGestureRecognizer, let (target, action) = SwipeBack.popHandler(of: pop) {
                    pans.append(SwipeBackPan(mode: .forward, target: target, action: action))
                }
                pans.append(SwipeBackPan(mode: .drawer, target: nil, action: nil))
                pans.forEach(nav.view.addGestureRecognizer)
            }
            for p in pans {
                p.navigation = nav
                p.isActiveTab = config.isActiveTab
                p.isCovered = config.isCovered
                p.openDrawer = config.openDrawer
                p.goBack = config.goBack
            }
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

private struct ClaimRecognizer: UIGestureRecognizerRepresentable {
    final class Recognizer: UIGestureRecognizer {
        private var tracked: [UITouch] = []
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            for t in touches { tracked.append(t); HorizontalTouchClaims.add(t) }
        }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
        override func reset() {
            super.reset()
            for t in tracked { HorizontalTouchClaims.remove(t) }
            tracked = []
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> Recognizer {
        let g = Recognizer()
        g.cancelsTouchesInView = false
        g.delaysTouchesEnded = false
        g.delegate = context.coordinator
        return g
    }
}

extension View {
    /// This view's horizontal drags are its own (scrubbing): the back swipe never starts on it.
    func claimsHorizontalSwipes() -> some View { gesture(ClaimRecognizer()) }
}
