import CoreGraphics

/// Drag to arrange Your Library: the geometry of libraryDrag.js, pure so it can be tested.
/// Rows are measured once at the lift, in the list's content coordinates.
enum LibraryDrag {
    /// libraryDrag.js constants.
    static let touchSlop: CGFloat = 8
    static let liftDelay: Double = 0.38
    static let edge: CGFloat = 56
    static let maxSpeed: CGFloat = 18

    struct Row: Equatable {
        var id: String
        var folder: Bool
        var rect: CGRect
    }

    struct Target: Equatable {
        /// The slot among all rows the lifted one lands in.
        var to: Int
        /// The folder it goes into instead.
        var into: String?
    }

    /// Where row `j` sits while the lifted row (`from`) is aimed at slot `to` (`shiftOf`).
    static func shift(_ rows: [Row], from: Int, to: Int, _ j: Int) -> CGSize {
        guard j != from, rows.indices.contains(j) else { return .zero }
        let k = j < from ? j : j - 1
        let nj = k < to ? k : k + 1
        guard rows.indices.contains(nj) else { return .zero }
        let a = rows[j].rect, b = rows[nj].rect
        return CGSize(width: b.minX - a.minX, height: b.minY - a.minY)
    }

    /// The landing place for a finger at `p` (content coordinates). Over a row (where it shows
    /// now): first half = before it, second half = after it, the middle of a folder = into it.
    /// Over the gap the others opened: no change (no flicker). Above all = 0, below all = last.
    static func target(_ rows: [Row], from: Int, current: Target, at p: CGPoint, canEnter: Bool) -> Target {
        guard !rows.isEmpty else { return current }
        var into: String?
        var to = current.to
        var over = false
        let grid = rows.contains { $0.rect.minX != rows[0].rect.minX }
        for j in rows.indices where j != from {
            let r = rows[j]
            let d = shift(rows, from: from, to: current.to, j)
            let top = r.rect.minY + d.height, left = r.rect.minX + d.width
            if p.x < left || p.x > left + r.rect.width || p.y < top || p.y > top + r.rect.height { continue }
            over = true
            let f = grid ? (p.x - left) / r.rect.width : (p.y - top) / r.rect.height
            let g = (p.y - top) / r.rect.height
            if r.folder && g > 0.25 && g < 0.75 && canEnter { into = r.id; break }
            let k = j < from ? j : j - 1
            to = f < 0.5 ? k : k + 1
            break
        }
        if !over && into == nil {
            let first = rows[0].rect, last = rows[rows.count - 1].rect
            if p.y < first.minY { to = 0 } else if p.y > last.maxY { to = rows.count - 1 }
        }
        return Target(to: to, into: into)
    }

    /// Auto-scroll speed (points per frame) for a finger at `y` in a viewport of `height`.
    static func autoScroll(y: CGFloat, height: CGFloat) -> CGFloat {
        if y < edge { return -maxSpeed * min(1, (edge - y) / edge) }
        if y > height - edge { return maxSpeed * min(1, (y - (height - edge)) / edge) }
        return 0
    }

    /// The drop line: inset 4 from the slot's left, slot width - 8 (min 8), at the slot's middle.
    /// Nil when it lands where it started or goes into a folder.
    static func dropLine(_ rows: [Row], from: Int, target: Target) -> CGRect? {
        guard target.into == nil, target.to != from, rows.indices.contains(target.to) else { return nil }
        let s = rows[target.to].rect
        return CGRect(x: s.minX + 4, y: s.midY - 1, width: max(8, s.width - 8), height: 2)
    }
}
