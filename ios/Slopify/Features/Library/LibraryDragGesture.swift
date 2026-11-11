import SwiftUI

/// Hold-to-drag on a row (libraryDrag.js): hold still 380 ms lifts it (the controller ticks the
/// haptic), then a move > 8 pt drags; letting go without moving is a hold (the menu).
/// - `onTap`: the row's own tap. Nil when the row handles taps itself (track rows).
/// - `highPriority`: wins over the row's own long-press (TrackRow opens its menu at 450 ms);
///   the row's taps still run when the hold fails.
struct LibraryDragGesture: ViewModifier {
    var onTap: (() -> Void)? = nil
    var highPriority = false
    var coordinateSpace: CoordinateSpace
    var onLift: () -> Void
    var onMove: (_ start: CGPoint, _ at: CGPoint) -> Void
    var onEnd: () -> Void

    @Environment(\.theme) private var theme
    @GestureState private var active = false
    @GestureState private var pressing = false
    @State private var lifted = false

    func body(content: Content) -> some View {
        let tapped = content
            .background { if pressing && !lifted && onTap != nil { theme.fg(0.08) } }
            .opacity(pressing && !lifted && onTap != nil ? 0.7 : 1)
            .contentShape(Rectangle())
            .onTapGesture { onTap?() }
        if highPriority {
            tapped.highPriorityGesture(gesture)
                .onChange(of: active) { _, a in if !a && lifted { finish() } }
        } else {
            tapped.gesture(gesture)
                // A cancelled gesture never calls onEnded: put the row back then too.
                .onChange(of: active) { _, a in if !a && lifted { finish() } }
        }
    }

    private var gesture: some Gesture {
        LongPressGesture(minimumDuration: LibraryDrag.liftDelay, maximumDistance: LibraryDrag.touchSlop)
            .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: coordinateSpace))
            .updating($active) { _, s, _ in s = true }
            .updating($pressing) { v, s, _ in if case .first(true) = v { s = true } }
            .onChanged { v in
                guard case .second(true, let d) = v else { return }
                if !lifted { lifted = true; onLift() }
                if let d { onMove(d.startLocation, d.location) }
            }
            .onEnded { _ in finish() }
    }

    private func finish() {
        guard lifted else { return }
        lifted = false
        onEnd()
    }
}
