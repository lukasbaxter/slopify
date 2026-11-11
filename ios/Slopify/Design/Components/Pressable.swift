import SwiftUI
import UIKit

/// Press feedback styles (UI.md 2.8 "Touch feel", 6.0.3).
enum PressFeedback: Sendable {
    /// Rows, shortcut tiles, menu items: background `rgba(fg,.08)` while pressed.
    case row
    /// Icon buttons, tab bar, transport: opacity .6.
    case fade
    /// Cards and tiles: artwork dims to brightness .8 (apply `.pressDim()` to the art).
    case dim
    case none
}

/// Tap + long-press for anything that has a context menu (UI.md 2.8):
/// hold still 450 ms (moving < 10 pt cancels) opens the menu with a light haptic, and the lift
/// after it does not count as a tap. `onTouchDown` fires as the finger lands (stream pre-warm).
///
///     row.pressable(.row, onTap: play, onLongPress: openMenu, onTouchDown: prewarm)
struct PressableModifier: ViewModifier {
    var feedback: PressFeedback
    var onTap: (() -> Void)?
    var onLongPress: (() -> Void)?
    var onTouchDown: (() -> Void)?

    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled
    @State private var pressed = false

    func body(content: Content) -> some View {
        content
            .background { if feedback == .row && pressed { theme.fg(0.08) } }
            .opacity(feedback == .fade && pressed ? 0.6 : 1)
            .environment(\.isPressed, pressed)
            .contentShape(Rectangle())
            .onTapGesture { if enabled { onTap?() } }
            .onLongPressGesture(minimumDuration: Gestures.longPressDuration, maximumDistance: Gestures.longPressSlop, perform: {
                guard enabled, let onLongPress else { return }
                Haptics.tick()
                onLongPress()
            }, onPressingChanged: { p in
                guard enabled else { return }
                pressed = p
                if p { onTouchDown?() }
            })
    }
}

/// A plain button style with the web's press feedback.
struct PressButtonStyle: ButtonStyle {
    var feedback: PressFeedback = .fade
    @Environment(\.theme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .background { if feedback == .row && configuration.isPressed { theme.fg(0.08) } }
            .opacity(feedback == .fade && configuration.isPressed ? 0.6 : 1)
            .environment(\.isPressed, configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressButtonStyle {
    /// Opacity .6 while pressed (icon buttons).
    static var pressFade: PressButtonStyle { PressButtonStyle(feedback: .fade) }
    /// `rgba(fg,.08)` background while pressed (rows).
    static var pressRow: PressButtonStyle { PressButtonStyle(feedback: .row) }
    /// No visual change (the label handles it, e.g. `.pressDim()` art).
    static var pressPlain: PressButtonStyle { PressButtonStyle(feedback: .dim) }
}

private struct PressedKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    /// True while the enclosing pressable/button is held. Read it for custom press looks.
    var isPressed: Bool {
        get { self[PressedKey.self] }
        set { self[PressedKey.self] = newValue }
    }
}

extension View {
    func pressable(_ feedback: PressFeedback = .row, onTap: (() -> Void)? = nil, onLongPress: (() -> Void)? = nil, onTouchDown: (() -> Void)? = nil) -> some View {
        modifier(PressableModifier(feedback: feedback, onTap: onTap, onLongPress: onLongPress, onTouchDown: onTouchDown))
    }

    /// Long-press only (450 ms / 10 pt + haptic), for views that already handle taps.
    func onLongPressMenu(_ action: @escaping () -> Void) -> some View {
        onLongPressGesture(minimumDuration: Gestures.longPressDuration, maximumDistance: Gestures.longPressSlop) {
            Haptics.tick(); action()
        }
    }

    /// Card art: brightness .8 while the enclosing button is pressed.
    func pressDim() -> some View { modifier(PressDim()) }
}

private struct PressDim: ViewModifier {
    @Environment(\.isPressed) private var pressed
    func body(content: Content) -> some View { content.colorMultiply(Color(white: pressed ? 0.8 : 1)) }
}

/// The web's `navigator.vibrate(10)`.
enum Haptics {
    @MainActor static func tick() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
}
