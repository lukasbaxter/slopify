import SwiftUI
import UIKit

/// The live drag of a list row (Your Library tree mode, playlist songs), libraryDrag.js on the
/// phone: one long-press recognizer on the list's own `UIScrollView`, not a gesture per row.
///
/// - A finger that moves more than 8 pt before 380 ms makes the recognizer fail, so the scroll
///   view's pan takes the touch: a swipe on a row scrolls.
/// - Held still for 380 ms over a drag row it begins (light haptic). From then the pan cannot
///   start (UIKit exclusivity), the row follows the finger, the others slide aside, the list
///   auto-scrolls near its edges. The recognizer's end (or cancel) always arrives, whatever
///   SwiftUI does with the row views meanwhile.
/// - Let go within 8 pt of the lift point: a hold (the row's menu). Otherwise a drop.
///
/// Every point is in the list's own coordinates (the view the probe sits behind), so rows,
/// finger and drop line share one space and scrolling under a still finger is accounted for.
@MainActor @Observable
final class LibraryDragController {
    struct Lift: Equatable {
        var id: String
        var rows: [LibraryDrag.Row]
        var from: Int
        var target: LibraryDrag.Target
        var start: CGPoint
        var finger: CGPoint
        /// Still within 8 pt of the lift point: letting go opens the menu instead.
        var held = true
    }

    enum Outcome: Equatable { case hold(String), drop(id: String, to: Int, into: String?, rows: [String]) }

    private(set) var lift: Lift?
    var isLifted: Bool { lift != nil }

    /// The drag rows now, in list coordinates (empty: nothing can be dragged, e.g. flat mode).
    @ObservationIgnored var rows: () -> [LibraryDrag.Row] = { [] }
    @ObservationIgnored var canEnter: (String) -> Bool = { _ in false }
    /// Before measuring: return true when the lift changes the layout (a folder drag shuts the
    /// folders), so the rows are measured a moment later.
    @ObservationIgnored var willLift: (String) -> Bool = { _ in false }
    @ObservationIgnored var onFinish: (Outcome?) -> Void = { _ in }
    /// Parts of the scroll view covered by chrome (detail top bar, mini player and tab bar),
    /// on top of whatever safe area the scroll view itself runs under.
    @ObservationIgnored var coveredTop: CGFloat = 0
    @ObservationIgnored var coveredBottom: CGFloat = 0

    @ObservationIgnored private let recognizer = UILongPressGestureRecognizer()
    @ObservationIgnored private let delegate = LibraryHoldDelegate()
    @ObservationIgnored private weak var probe: UIView?
    @ObservationIgnored private weak var scrollView: UIScrollView?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var pendingId: String?

    init() {
        recognizer.minimumPressDuration = LibraryDrag.liftDelay
        recognizer.allowableMovement = LibraryDrag.touchSlop
        recognizer.delaysTouchesBegan = false
        // Once it begins, the row's own tap / 450 ms menu press get cancelled.
        recognizer.cancelsTouchesInView = true
        recognizer.addTarget(self, action: #selector(handle(_:)))
        delegate.shouldBegin = { [weak self] g in
            guard let self, let probe = self.probe else { return false }
            return self.rowId(at: g.location(in: probe)) != nil
        }
        recognizer.delegate = delegate
    }

    /// Called by `LibraryDragProbe` once it sits in the list's scroll view.
    func attach(probe: UIView, scrollView: UIScrollView) {
        self.probe = probe
        guard self.scrollView !== scrollView else { return }
        self.scrollView?.removeGestureRecognizer(recognizer)
        self.scrollView = scrollView
        scrollView.addGestureRecognizer(recognizer)
    }

    func rowId(at p: CGPoint) -> String? { rows().first { $0.rect.contains(p) }?.id }

    // MARK: - The state machine (UIKit-free, tested)

    func begin(id: String, rows: [LibraryDrag.Row], at p: CGPoint) {
        guard lift == nil, let from = rows.firstIndex(where: { $0.id == id }) else { return }
        lift = Lift(id: id, rows: rows, from: from, target: .init(to: from, into: nil), start: p, finger: p)
    }

    func move(to p: CGPoint) {
        guard var l = lift else { return }
        l.finger = p
        if hypot(p.x - l.start.x, p.y - l.start.y) > LibraryDrag.touchSlop { l.held = false }
        l.target = LibraryDrag.target(l.rows, from: l.from, current: l.target, at: p, canEnter: canEnter(l.id))
        if l != lift { lift = l }
    }

    /// Let go. Nil = put back (no move, or moved back to its own slot).
    func end() -> Outcome? {
        guard let l = lift else { return nil }
        lift = nil
        if l.held { return .hold(l.id) }
        if l.target.into != nil || l.target.to != l.from {
            return .drop(id: l.id, to: l.target.to, into: l.target.into, rows: l.rows.map(\.id))
        }
        return nil
    }

    /// The touch was taken away (call, system gesture): everything goes back.
    func cancel() { lift = nil }

    /// How far a row is drawn from its own place.
    func offset(for id: String) -> CGSize {
        guard let l = lift, let j = l.rows.firstIndex(where: { $0.id == id }) else { return .zero }
        if j == l.from { return CGSize(width: l.finger.x - l.start.x, height: l.finger.y - l.start.y) }
        return LibraryDrag.shift(l.rows, from: l.from, to: l.target.to, j)
    }

    var dropLine: CGRect? { lift.flatMap { LibraryDrag.dropLine($0.rows, from: $0.from, target: $0.target) } }
    var targetFolder: String? { lift?.target.into }

    // MARK: - UIKit

    @objc private func handle(_ g: UILongPressGestureRecognizer) {
        guard let probe else { return }
        let p = g.location(in: probe)
        switch g.state {
        case .began:
            guard let id = rowId(at: p) else { return }
            Haptics.tick()
            startTimer()
            if willLift(id) {
                pendingId = id
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    guard let self, self.pendingId == id else { return }
                    self.pendingId = nil
                    self.begin(id: id, rows: self.rows(), at: p)
                    if let probe = self.probe { self.move(to: g.location(in: probe)) }
                }
            } else {
                begin(id: id, rows: rows(), at: p)
            }
        case .changed:
            move(to: p)
        case .ended:
            finish(end())
        case .cancelled, .failed:
            pendingId = nil
            cancel()
            finish(nil)
        default:
            break
        }
    }

    private func finish(_ outcome: Outcome?) {
        timer?.invalidate(); timer = nil
        onFinish(outcome)
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    /// Near the visible edges the list scrolls; the finger's list point moves with it.
    private func tick() {
        guard lift != nil, let sv = scrollView, let probe else { return }
        let top = coveredTop + sv.safeAreaInsets.top, bottom = coveredBottom + sv.safeAreaInsets.bottom
        let inView = recognizer.location(in: sv).y - sv.contentOffset.y
        let v = LibraryDrag.autoScroll(y: inView - top, height: sv.bounds.height - top - bottom)
        guard v != 0 else { return }
        let minY = -sv.adjustedContentInset.top
        let maxY = max(minY, sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom)
        let y = min(maxY, max(minY, sv.contentOffset.y + v))
        guard y != sv.contentOffset.y else { return }
        sv.contentOffset.y = y
        move(to: recognizer.location(in: probe))
    }
}

/// Lets the recognizer begin only over a drag row (elsewhere the page's own presses work).
private final class LibraryHoldDelegate: NSObject, UIGestureRecognizerDelegate {
    var shouldBegin: (UIGestureRecognizer) -> Bool = { _ in false }
    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool { MainActor.assumeIsolated { shouldBegin(g) } }
}

/// Put behind the list (`.background(LibraryDragProbe(drag: drag))`): its frame is the list's,
/// and it hands the controller the enclosing scroll view.
struct LibraryDragProbe: UIViewRepresentable {
    let drag: LibraryDragController

    func makeUIView(context: Context) -> Probe { Probe(drag: drag) }
    func updateUIView(_ v: Probe, context: Context) { v.find() }

    final class Probe: UIView {
        let drag: LibraryDragController
        init(drag: LibraryDragController) { self.drag = drag; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); find() }
        func find() {
            var v = superview
            while let s = v, !(s is UIScrollView) { v = s.superview }
            if let sv = v as? UIScrollView { drag.attach(probe: self, scrollView: sv) }
        }
    }
}
