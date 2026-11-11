import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Swipe right on a track row to add it to the queue (Spotify iOS, owner 11-11).
/// The pure maths and gating live here so they are tested without a finger.
enum SwipeToQueue {
    /// Commit distance: 80 pt, or a quarter of the row on narrow rows.
    static let maxThreshold: CGFloat = 80
    static let widthShare: CGFloat = 0.25
    /// Touches that start this close to the left screen edge belong to the system back swipe.
    static let edgeGuard: CGFloat = 20
    /// Movement (pt) after which a vertical or leftward drag fails the pan at once, so the
    /// list scroll never waits on it.
    static let decideSlop: CGFloat = 6

    static func threshold(width: CGFloat) -> CGFloat {
        width > 0 ? min(maxThreshold, width * widthShare) : maxThreshold
    }

    /// Where the row is drawn for a finger `dx` to the right: 1:1 up to the threshold, then a
    /// rubber band that never reaches twice the threshold.
    static func displayOffset(_ dx: CGFloat, threshold t: CGFloat) -> CGFloat {
        guard dx > 0, t > 0 else { return 0 }
        guard dx > t else { return dx }
        let over = dx - t
        return t + (1 - 1 / (over * 0.55 / t + 1)) * t
    }

    /// 0...1, drives the glyph's size and brightness.
    static func progress(_ dx: CGFloat, threshold t: CGFloat) -> CGFloat {
        t > 0 ? min(1, max(0, dx / t)) : 0
    }

    static func isArmed(_ dx: CGFloat, threshold t: CGFloat) -> Bool { dx >= t }

    /// Rightward and more horizontal than vertical (45 degrees).
    static func isRightward(_ d: CGPoint) -> Bool { d.x > 0 && d.x > abs(d.y) }

    /// The early-fail rule while the pan is still deciding: vertical or leftward movement.
    static func shouldFailEarly(_ translation: CGPoint) -> Bool {
        let dx = translation.x, dy = translation.y
        if dx < -decideSlop { return true }
        return abs(dy) > decideSlop && abs(dy) >= abs(dx)
    }

    /// The pan may begin: a queueable row, not from the screen edge, before the 450 ms menu
    /// press, moving right. `translation` decides (it is the real first movement); velocity
    /// only when the finger has not moved yet.
    static func shouldBegin(startX: CGFloat, translation: CGPoint, velocity: CGPoint, heldFor: TimeInterval, queueable: Bool) -> Bool {
        guard queueable, startX >= edgeGuard, heldFor < Gestures.longPressDuration else { return false }
        return isRightward(translation == .zero ? velocity : translation)
    }

    /// Offline only downloaded songs can be queued (the track menu keeps "Add to queue" offline
    /// only when `downloaded`).
    static func canQueue(offline: Bool, downloaded: Bool) -> Bool { !offline || downloaded }
}

/// Touches that landed on a track row, so the Library back swipe can leave them to the row.
@MainActor
enum SwipeToQueueTouches {
    private static let rows = NSHashTable<UITouch>.weakObjects()
    static func add(_ t: UITouch) { rows.add(t) }
    static func remove(_ t: UITouch) { rows.remove(t) }
    static func contains(_ t: UITouch) -> Bool { rows.contains(t) }
}

/// The row's pan. Every other non-edge pan under the same touch (the list scroll, the Library
/// back swipe, the iOS 26 full-width content pop) waits for it to fail, which it does within 6 pt of a
/// vertical or leftward move.
final class SwipeToQueueRecognizer: UIPanGestureRecognizer {
    private(set) var downAt: TimeInterval = 0
    private var startPoint: CGPoint = .zero
    private var tracked: [UITouch] = []

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if tracked.isEmpty, let t = touches.first {
            downAt = t.timestamp
            startPoint = t.location(in: nil)
        }
        for t in touches { tracked.append(t); SwipeToQueueTouches.add(t) }
        // The edge belongs to the system back swipe: step aside before it has to wait.
        if state == .possible, startPoint.x < SwipeToQueue.edgeGuard { state = .failed }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible, let t = touches.first {
            let p = t.location(in: nil)
            if SwipeToQueue.shouldFailEarly(CGPoint(x: p.x - startPoint.x, y: p.y - startPoint.y)) {
                state = .failed
                return
            }
        }
        super.touchesMoved(touches, with: event)
    }

    override func reset() {
        super.reset()
        for t in tracked { SwipeToQueueTouches.remove(t) }
        tracked = []
    }

    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        if other is SwipeToQueueRecognizer || other is UIScreenEdgePanGestureRecognizer { return false }
        // The edge swipe is a plain pan subclass on iOS 26+, so match it by identity.
        if other === nearestNavigation?.interactivePopGestureRecognizer { return false }
        if other is UIPanGestureRecognizer { return true }
        return super.shouldBeRequiredToFail(by: other)
    }

    private var nearestNavigation: UINavigationController? {
        var r: UIResponder? = view
        while let x = r {
            if let vc = x as? UIViewController, let n = vc.navigationController { return n }
            r = x.next
        }
        return nil
    }

    /// Where the touch landed, in window coordinates.
    var startInWindow: CGPoint { startPoint }
}

private struct SwipeToQueueGesture: UIGestureRecognizerRepresentable {
    var queueable: () -> Bool
    var changed: (CGFloat) -> Void
    var ended: (_ cancelled: Bool) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var queueable: () -> Bool = { false }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                guard let pan = g as? SwipeToQueueRecognizer else { return false }
                return SwipeToQueue.shouldBegin(startX: pan.startInWindow.x, translation: pan.translation(in: nil),
                                                velocity: pan.velocity(in: nil),
                                                heldFor: ProcessInfo.processInfo.systemUptime - pan.downAt,
                                                queueable: queueable())
            }
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> SwipeToQueueRecognizer {
        let g = SwipeToQueueRecognizer()
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        context.coordinator.queueable = queueable
        return g
    }

    func updateUIGestureRecognizer(_ g: SwipeToQueueRecognizer, context: Context) {
        context.coordinator.queueable = queueable
        if g.delegate !== context.coordinator { g.delegate = context.coordinator }
    }

    func handleUIGestureRecognizerAction(_ g: SwipeToQueueRecognizer, context: Context) {
        switch g.state {
        case .began, .changed: changed(max(0, g.translation(in: g.view).x))
        case .ended: ended(false)
        case .cancelled, .failed: ended(true)
        default: break
        }
    }
}

/// The row content follows the finger; a queue glyph grows in the gap on the left and turns
/// accent at the threshold (haptic tick); letting go past it runs `onQueue`. Springs back.
private struct SwipeToQueueModifier: ViewModifier {
    var enabled: Bool
    var queueable: () -> Bool
    var onQueue: () -> Void

    @Environment(\.theme) private var theme
    @State private var dx: CGFloat = 0
    @State private var armed = false
    @State private var width: CGFloat = 0

    func body(content: Content) -> some View {
        let t = SwipeToQueue.threshold(width: width)
        let shown = SwipeToQueue.displayOffset(dx, threshold: t)
        content
            .offset(x: shown)
            .background(alignment: .leading) {
                if shown > 0 { glyph(progress: SwipeToQueue.progress(dx, threshold: t), band: shown) }
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
            .gesture(SwipeToQueueGesture(queueable: { enabled && queueable() }, changed: { x in
                let now = SwipeToQueue.isArmed(x, threshold: SwipeToQueue.threshold(width: width))
                if now && !armed { Haptics.tick() }
                armed = now
                dx = x
            }, ended: { cancelled in
                if !cancelled && armed { onQueue() }
                armed = false
                withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { dx = 0 }
            }))
    }

    private func glyph(progress p: CGFloat, band: CGFloat) -> some View {
        IconView(.queue, size: 24)
            .foregroundStyle(armed ? theme.accent : theme.fgSub)
            .scaleEffect(0.6 + 0.4 * p)
            .opacity(0.3 + 0.7 * p)
            .frame(width: band)
            .frame(maxHeight: .infinity)
            .clipped()
            .animation(.easeOut(duration: 0.12), value: armed)
            .accessibilityHidden(true)
    }
}

extension View {
    /// Swipe right to queue. `queueable` is asked when a swipe starts (offline rule).
    func swipeToQueue(enabled: Bool = true, queueable: @escaping () -> Bool = { true }, onQueue: @escaping () -> Void) -> some View {
        modifier(SwipeToQueueModifier(enabled: enabled, queueable: queueable, onQueue: onQueue))
    }
}
