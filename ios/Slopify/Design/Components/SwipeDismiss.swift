import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// Swipe down to close (owner 11-12): the one dismiss gesture for every sheet, menu, now playing,
/// the queue and (leftwards) the account drawer. It starts anywhere on the card while the scroll
/// view under the finger is at its top, follows the finger, rubber-bands the wrong way, and closes
/// past `distance` or on a flick; otherwise it springs back. A UIKit pan, so it runs alongside
/// the card's own scroll view instead of losing the touch to it.
enum SwipeDismiss {
    enum Direction: Sendable { case down, left }

    /// Wrong-way travel is shown as a rubber band that never passes this.
    static let rubberMax: CGFloat = 24
    /// A flick: faster than this (pt/s) along the axis, past `flickMinDistance`.
    static var flickVelocity: CGFloat { Gestures.flickVelocity }
    static let flickMinDistance: CGFloat = 20
    /// Seconds of release speed added to the travel when judging a flick.
    static let flickProjection: CGFloat = 0.2
    /// "At the top" tolerance of the scroll view under the finger.
    static let topEpsilon: CGFloat = 1

    /// Travel along the dismiss direction (positive = closing) and across it.
    static func along(_ t: CGPoint, _ d: Direction) -> CGFloat { d == .down ? t.y : -t.x }
    static func across(_ t: CGPoint, _ d: Direction) -> CGFloat { d == .down ? t.x : t.y }

    /// The first movement heads the closing way, within 45 degrees of the axis.
    static func isDismissward(_ t: CGPoint, _ d: Direction) -> Bool {
        along(t, d) > 0 && along(t, d) >= abs(across(t, d))
    }

    /// May begin: closing direction (translation decides, velocity only before any movement),
    /// and the scroll view under the finger (if any) is at its top.
    static func shouldBegin(translation: CGPoint, velocity: CGPoint, direction: Direction, scrollAtTop: Bool) -> Bool {
        scrollAtTop && isDismissward(translation == .zero ? velocity : translation, direction)
    }

    /// Where the card is drawn for `along` pt of travel: 1:1 the closing way, a rubber band the other.
    static func displayOffset(_ along: CGFloat, rubberBand: Bool) -> CGFloat {
        guard along < 0 else { return along }
        guard rubberBand else { return 0 }
        return -(1 - 1 / (-along * 0.55 / rubberMax + 1)) * rubberMax
    }

    /// Close past `distance`, or when the release speed would carry it there (a flick; UIKit's
    /// velocity has already eased off by the time a quick flick lifts); never when flung back.
    static func shouldDismiss(along: CGFloat, velocity: CGFloat, distance: CGFloat) -> Bool {
        if velocity < -flickVelocity { return false }
        return along > distance || (along > flickMinDistance && along + velocity * flickProjection > distance)
    }

    /// Full-screen covers (now playing, queue): slide the rest of the way, then close without
    /// the system slide.
    @MainActor static func slideOut(_ offset: Binding<CGFloat>, to height: CGFloat, close: @escaping () -> Void) {
        withAnimation(Motion.sheet(0.25)) { offset.wrappedValue = height }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { close() }
        }
    }

    static func isAtTop(offsetY: CGFloat, insetTop: CGFloat) -> Bool { offsetY + insetTop <= topEpsilon }

    /// The innermost vertical scroll view under a window point (horizontal shelves are skipped).
    @MainActor static func verticalScroll(at p: CGPoint, in window: UIWindow) -> UIScrollView? {
        var v = window.hitTest(p, with: nil)
        while let x = v {
            if let s = x as? UIScrollView, s.isScrollEnabled, s.contentSize.width <= s.bounds.width + 1 { return s }
            v = x.superview
        }
        return nil
    }
}

final class SwipeDismissRecognizer: UIPanGestureRecognizer {
    var direction: SwipeDismiss.Direction = .down
    /// The vertical scroll view the touch landed in, if any.
    private(set) weak var scroll: UIScrollView?
    private(set) var startInWindow: CGPoint = .zero

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard numberOfTouches <= 1, let t = touches.first, let w = t.window else { return }
        startInWindow = t.location(in: nil)
        scroll = direction == .down ? SwipeDismiss.verticalScroll(at: startInWindow, in: w) : nil
    }

    override func reset() {
        super.reset()
        scroll = nil
    }

    var scrollAtTop: Bool {
        guard let s = scroll else { return true }
        return SwipeDismiss.isAtTop(offsetY: s.contentOffset.y, insetTop: s.adjustedContentInset.top)
    }

    /// The card takes over: the scroll view stops (cancelled) and sits at its top.
    func takeOverScroll() {
        guard let s = scroll else { return }
        s.panGestureRecognizer.isEnabled = false
        s.panGestureRecognizer.isEnabled = true
        s.setContentOffset(CGPoint(x: s.contentOffset.x, y: -s.adjustedContentInset.top), animated: false)
    }
}

private struct SwipeDismissGesture: UIGestureRecognizerRepresentable {
    var direction: SwipeDismiss.Direction
    var canBegin: (CGPoint) -> Bool
    var changed: (_ along: CGFloat) -> Void
    var ended: (_ along: CGFloat, _ velocity: CGFloat, _ cancelled: Bool) -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var canBegin: (CGPoint) -> Bool = { _ in true }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            MainActor.assumeIsolated {
                guard let pan = g as? SwipeDismissRecognizer else { return false }
                return SwipeDismiss.shouldBegin(translation: pan.translation(in: nil), velocity: pan.velocity(in: nil),
                                                direction: pan.direction, scrollAtTop: pan.scrollAtTop)
                    && canBegin(pan.startInWindow)
            }
        }

        // Alongside everything: the scroll view, buttons, the art's skip swipe.
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> SwipeDismissRecognizer {
        let g = SwipeDismissRecognizer()
        g.direction = direction
        g.maximumNumberOfTouches = 1
        g.delegate = context.coordinator
        context.coordinator.canBegin = canBegin
        return g
    }

    func updateUIGestureRecognizer(_ g: SwipeDismissRecognizer, context: Context) {
        g.direction = direction
        context.coordinator.canBegin = canBegin
    }

    func handleUIGestureRecognizerAction(_ g: SwipeDismissRecognizer, context: Context) {
        let along = SwipeDismiss.along(g.translation(in: nil), direction)
        switch g.state {
        case .began:
            g.takeOverScroll()
            changed(along)
        case .changed: changed(along)
        case .ended: ended(along, SwipeDismiss.along(g.velocity(in: nil), direction), false)
        case .cancelled, .failed: ended(along, 0, true)
        default: break
        }
    }
}

private struct SwipeDismissModifier: ViewModifier {
    var direction: SwipeDismiss.Direction
    @Binding var offset: CGFloat
    var distance: CGFloat
    var rubberBand: Bool
    var canBegin: (CGPoint) -> Bool
    var onDismiss: () -> Void

    func body(content: Content) -> some View {
        content.gesture(SwipeDismissGesture(direction: direction, canBegin: canBegin, changed: { along in
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { offset = SwipeDismiss.displayOffset(along, rubberBand: rubberBand) }
        }, ended: { along, velocity, cancelled in
            if !cancelled && SwipeDismiss.shouldDismiss(along: along, velocity: velocity, distance: distance) {
                onDismiss()
            } else {
                withAnimation(Motion.snapBack) { offset = 0 }
            }
        }))
    }
}

extension View {
    /// Swipe down (or left) to close. The modifier writes the drag into `offset` (the caller draws
    /// it, e.g. `.offset(y: offset)`) and springs it back; past `distance` or on a flick it calls
    /// `onDismiss`, which runs the exit. `canBegin` gets the touch-down point (window space).
    ///
    ///     .offset(y: drag)
    ///     .swipeToDismiss(offset: $drag, canBegin: { _ in !scrubbing }) { close() }
    func swipeToDismiss(_ direction: SwipeDismiss.Direction = .down, offset: Binding<CGFloat>,
                        distance: CGFloat = Gestures.sheetDismissDistance, rubberBand: Bool = true,
                        canBegin: @escaping (CGPoint) -> Bool = { _ in true },
                        onDismiss: @escaping () -> Void) -> some View {
        modifier(SwipeDismissModifier(direction: direction, offset: offset, distance: distance, rubberBand: rubberBand,
                                      canBegin: canBegin, onDismiss: onDismiss))
    }
}
