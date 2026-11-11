import SwiftUI
import UIKit

/// The live drag of a Your Library row (tree mode): lift at 380 ms, follow the finger, slide the
/// others aside, auto-scroll near the edges, drop or put back. Geometry from `LibraryDrag`.
@MainActor @Observable
final class LibraryDragController {
    struct Lift: Equatable {
        var id: String
        var rows: [LibraryDrag.Row]
        var from: Int
        var target: LibraryDrag.Target
        /// Finger position in the viewport, and where it grabbed the row (viewport, row origin).
        var finger: CGPoint?
        var grab: CGSize?
        var start: CGPoint?
        /// Still within 8 pt of where it lifted: letting go opens the menu instead.
        var held = true
    }

    private(set) var lift: Lift?
    /// The content's top-left in the viewport (negative once scrolled).
    var contentOrigin: CGPoint = .zero { didSet { if lift != nil { retarget() } } }
    @ObservationIgnored var viewport: CGSize = .zero
    /// Where the viewport starts in the finger's coordinates (a detail page: below its top bar).
    @ObservationIgnored var viewportTop: CGFloat = 0
    @ObservationIgnored var canEnter: (String) -> Bool = { _ in true }
    @ObservationIgnored let scroll = LibraryScrollHandle()
    @ObservationIgnored private var timer: Timer?

    var isLifted: Bool { lift != nil }

    func begin(id: String, rows: [LibraryDrag.Row]) {
        guard lift == nil, let from = rows.firstIndex(where: { $0.id == id }) else { return }
        Haptics.tick()
        scroll.view?.isScrollEnabled = false
        lift = Lift(id: id, rows: rows, from: from, target: .init(to: from, into: nil))
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    func move(start: CGPoint, to p: CGPoint) {
        guard var l = lift else { return }
        if l.start == nil {
            l.start = start
            let r = l.rows[l.from].rect
            l.grab = CGSize(width: start.x - (r.minX + contentOrigin.x), height: start.y - (r.minY + contentOrigin.y))
        }
        l.finger = p
        if let s = l.start, hypot(p.x - s.x, p.y - s.y) > LibraryDrag.touchSlop { l.held = false }
        lift = l
        retarget()
    }

    /// Ends the drag. Returns what happened: nil = put back, `.hold` = open the menu, `.drop`.
    enum Outcome: Equatable { case hold(String), drop(id: String, to: Int, into: String?, rows: [String]) }

    func end() -> Outcome? {
        timer?.invalidate(); timer = nil
        scroll.view?.isScrollEnabled = true
        guard let l = lift else { return nil }
        lift = nil
        if l.held { return .hold(l.id) }
        if l.target.into != nil || l.target.to != l.from {
            return .drop(id: l.id, to: l.target.to, into: l.target.into, rows: l.rows.map(\.id))
        }
        return nil
    }

    /// How far a row is drawn from its own place.
    func offset(for id: String) -> CGSize {
        guard let l = lift, let j = l.rows.firstIndex(where: { $0.id == id }) else { return .zero }
        if j == l.from {
            guard let f = l.finger, let g = l.grab else { return .zero }
            let r = l.rows[j].rect
            return CGSize(width: f.x - g.width - (r.minX + contentOrigin.x), height: f.y - g.height - (r.minY + contentOrigin.y))
        }
        return LibraryDrag.shift(l.rows, from: l.from, to: l.target.to, j)
    }

    var dropLine: CGRect? { lift.flatMap { LibraryDrag.dropLine($0.rows, from: $0.from, target: $0.target) } }
    var targetFolder: String? { lift?.target.into }

    private func retarget() {
        guard var l = lift, let f = l.finger else { return }
        let p = CGPoint(x: f.x - contentOrigin.x, y: f.y - contentOrigin.y)
        let t = LibraryDrag.target(l.rows, from: l.from, current: l.target, at: p, canEnter: canEnter(l.id))
        if t != l.target { l.target = t; lift = l }
    }

    private func tick() {
        guard let f = lift?.finger, let sv = scroll.view else { return }
        let v = LibraryDrag.autoScroll(y: f.y - viewportTop, height: viewport.height)
        guard v != 0 else { return }
        let minY = -sv.adjustedContentInset.top
        let maxY = max(minY, sv.contentSize.height - sv.bounds.height + sv.adjustedContentInset.bottom)
        let y = min(maxY, max(minY, sv.contentOffset.y + v))
        if y != sv.contentOffset.y { sv.contentOffset.y = y }
    }
}

/// Finds the enclosing `UIScrollView` (auto-scroll while dragging).
final class LibraryScrollHandle {
    weak var view: UIScrollView?
}

struct LibraryScrollFinder: UIViewRepresentable {
    let handle: LibraryScrollHandle

    func makeUIView(context: Context) -> Probe { Probe(handle: handle) }
    func updateUIView(_ v: Probe, context: Context) { v.find() }

    final class Probe: UIView {
        let handle: LibraryScrollHandle
        init(handle: LibraryScrollHandle) { self.handle = handle; super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); find() }
        func find() {
            var v = superview
            while let s = v, !(s is UIScrollView) { v = s.superview }
            if let sv = v as? UIScrollView { handle.view = sv }
        }
    }
}
