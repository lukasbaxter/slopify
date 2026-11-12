import SwiftUI

/// Swipe left / right to skip, the one implementation for the mini player and the now playing
/// art (owner 11-12). The first 6 pt pick the axis; sideways, the caller's content follows the
/// finger (`state.dx`, `state.opacity`), slides out on a skip and back in from the other side.
/// Up/down is left to the page (now playing's swipe down) or to `onSwipeUp` (the mini player).
struct SkipSwipeState: Equatable {
    var dx: CGFloat = 0
    var opacity: Double = 1
    fileprivate var axis: Axis?
}

private struct SwipeToSkipModifier: ViewModifier {
    @Binding var state: SkipSwipeState
    /// How far the content slides out on a skip.
    var width: CGFloat
    var enabled: Bool
    var onSwipeUp: (() -> Void)?
    var onSkip: (NowPlayingMath.Skip) -> Void

    func body(content: Content) -> some View {
        content.simultaneousGesture(
            DragGesture(minimumDistance: 6, coordinateSpace: .global)
                .onChanged { v in
                    let x = v.translation.width, y = v.translation.height
                    if state.axis == nil { state.axis = NowPlayingMath.abandonsSwipe(dx: x, dy: y) ? .vertical : .horizontal }
                    guard state.axis == .horizontal, enabled else { return }
                    let f = NowPlayingMath.skipFollow(dx: x)
                    state.dx = f.offset; state.opacity = f.opacity
                }
                .onEnded { v in
                    let axis = state.axis
                    state.axis = nil
                    let x = v.translation.width, y = v.translation.height
                    if axis == .vertical, let onSwipeUp, NowPlayingMath.opensNowPlaying(dx: x, dy: y, velocityY: v.velocity.height) {
                        onSwipeUp()
                    } else if axis == .horizontal, enabled, let s = NowPlayingMath.skip(dx: x, dy: y, velocityX: v.velocity.width) {
                        run(s)
                    } else if state.dx != 0 || state.opacity != 1 {
                        withAnimation(Motion.snapBack) { state.dx = 0; state.opacity = 1 }
                    }
                })
    }

    private func run(_ s: NowPlayingMath.Skip) {
        onSkip(s)
        withAnimation(.easeOut(duration: 0.18)) { state.dx = (s == .next ? -1.2 : 1.2) * width; state.opacity = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { state.dx = s == .next ? 40 : -40 }
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.2)) { state.dx = 0; state.opacity = 1 }
            }
        }
    }
}

extension View {
    /// Swipe left = next, right = previous. Draw `state.dx` / `state.opacity` on what should move.
    func swipeToSkip(_ state: Binding<SkipSwipeState>, width: CGFloat, enabled: Bool = true,
                     onSwipeUp: (() -> Void)? = nil, onSkip: @escaping (NowPlayingMath.Skip) -> Void) -> some View {
        modifier(SwipeToSkipModifier(state: state, width: width, enabled: enabled, onSwipeUp: onSwipeUp, onSkip: onSkip))
    }
}
