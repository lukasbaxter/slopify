import SwiftUI

/// Where a sheet host is in its life: entering (not yet `appeared`), shown, or `leaving`.
struct SheetPhase: Hashable, Sendable {
    var appeared = false
    var leaving = false
}

/// Closes the enclosing sheet host (all its sheets), then runs `then` once it is gone.
struct SheetCloseAction {
    var run: (_ then: (() -> Void)?) -> Void = { _ in }
    func callAsFunction(_ then: (() -> Void)? = nil) { run(then) }
}

private struct SheetPhaseKey: EnvironmentKey { static let defaultValue = SheetPhase(appeared: true) }
private struct SheetCloseKey: EnvironmentKey { static let defaultValue = SheetCloseAction() }

extension EnvironmentValues {
    var sheetPhase: SheetPhase {
        get { self[SheetPhaseKey.self] }
        set { self[SheetPhaseKey.self] = newValue }
    }
    /// Inside a bottom sheet or context menu: close it (`closeSheet { action() }`).
    var closeSheet: SheetCloseAction {
        get { self[SheetCloseKey.self] }
        set { self[SheetCloseKey.self] = newValue }
    }
}

/// Scrim plus the sheets of one presentation (UI.md 3.8, 5.5): black 60 % scrim fading in over
/// 0.2 s; tapping it closes everything and never falls through. Closing slides the sheets down
/// (0.25 s ease-in, the one dismiss for every sheet) and fades the scrim, then dismisses.
struct SheetHost<Content: View>: View {
    var dismiss: (_ then: (() -> Void)?) -> Void
    @ViewBuilder var content: () -> Content
    @State private var phase = SheetPhase()

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.Fixed.sheetScrim
                .opacity(phase.appeared && !phase.leaving ? 1 : 0)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close(nil) }
                .accessibilityLabel(L("Close"))
                .accessibilityAddTraits(.isButton)
            content()
        }
        .environment(\.sheetPhase, phase)
        .environment(\.closeSheet, SheetCloseAction(run: close))
        .onAppear { withAnimation(Motion.sheetIn) { phase.appeared = true } }
    }

    private func close(_ then: (() -> Void)?) {
        guard !phase.leaving else { return }
        withAnimation(Motion.sheetOut) { phase.leaving = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { dismiss(then) }
    }
}

/// One sheet panel: pinned to the bottom, top radius 16, `--sheet`, shadow `0 -8 40 .6`,
/// padding 12 8 (24 + bottom inset), at most 80 % of the screen (content scrolls inside),
/// 36x4 grabber 6 pt from the top. Enters from +40 pt with a fade (0.2 s); sub-sheets
/// (`sub: true`) appear without animation and are at least 45 % tall.
/// Swipe down anywhere on it (`swipeToDismiss`, the list at its top) closes everything.
struct BottomSheetFrame<Content: View>: View {
    var sub = false
    @ViewBuilder var content: () -> Content

    @Environment(\.theme) private var theme
    @Environment(\.sheetPhase) private var phase
    @Environment(\.closeSheet) private var closeSheet
    @State private var drag: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var bornShown = false

    init(sub: Bool = false, @ViewBuilder content: @escaping () -> Content) {
        self.sub = sub; self.content = content
    }

    var body: some View {
        GeometryReader { g in
            let screenH = g.size.height + g.safeAreaInsets.top + g.safeAreaInsets.bottom
            let maxH = screenH * 0.8
            let bottomPad = 24 + g.safeAreaInsets.bottom
            let natural = contentHeight + 12 + bottomPad
            let fits = natural <= maxH
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ZStack(alignment: .top) {
                    Group {
                        if fits { measured } else { ScrollView { measured }.scrollIndicators(.hidden) }
                    }
                    .padding(.top, 12)
                    .padding(.horizontal, 8)
                    .padding(.bottom, bottomPad)
                    .frame(maxWidth: .infinity, minHeight: sub ? screenH * 0.45 : 0, maxHeight: fits ? max(natural, sub ? screenH * 0.45 : 0) : maxH, alignment: .top)
                    if !sub {
                        Capsule().fill(theme.fg(0.25)).frame(width: 36, height: 4).padding(.top, 6).accessibilityHidden(true)
                    }
                }
                // Room below the screen edge for the upward rubber band.
                .padding(.bottom, SwipeDismiss.rubberMax)
                .background(theme.sheet)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: Radius.sheet, topTrailingRadius: Radius.sheet))
                .shadow(color: .black.opacity(phase.leaving ? 0 : 0.6), radius: 20, y: -8)
                .padding(.bottom, -SwipeDismiss.rubberMax)
                .offset(y: offset(screenH))
                .opacity(entering ? 0 : 1)
                .contentShape(Rectangle())
                .onTapGesture {} // a tap on the sheet never reaches the scrim
                .swipeToDismiss(offset: $drag, canBegin: { _ in !phase.leaving }) { closeSheet() }
            }
            .ignoresSafeArea(edges: .bottom)
        }
        .onAppear { if phase.appeared { bornShown = true } }
    }

    private var entering: Bool { !sub && !bornShown && !phase.appeared }

    private var measured: some View {
        content().background(GeometryReader { g in
            Color.clear.onAppear { contentHeight = g.size.height }.onChange(of: g.size.height) { _, h in contentHeight = h }
        })
    }

    private func offset(_ screenH: CGFloat) -> CGFloat {
        if phase.leaving { return screenH }
        if entering { return 40 }
        return drag
    }
}

/// Identifiable token for boolean presentation.
struct SheetToken: Identifiable, Hashable { let id = UUID() }

extension View {
    /// A generic bottom sheet over everything (device sheet, sleep timer). Inside, close with
    /// `@Environment(\.closeSheet)`: `closeSheet { then() }`.
    ///
    ///     .bottomSheet(item: $picker) { picker in DeviceList(picker) }
    func bottomSheet<Item: Identifiable, Content: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil,
                                                       @ViewBuilder content: @escaping (Item) -> Content) -> some View {
        overlayCover(item: item, onDismiss: onDismiss) { it, dismiss in
            SheetHost(dismiss: dismiss) { BottomSheetFrame { content(it) } }
        }
    }

    /// Boolean form of `bottomSheet(item:)`.
    func bottomSheet<Content: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil,
                                    @ViewBuilder content: @escaping () -> Content) -> some View {
        modifier(BoolSheet(isPresented: isPresented, onDismiss: onDismiss, sheet: content))
    }
}

private struct BoolSheet<C: View>: ViewModifier {
    @Binding var isPresented: Bool
    var onDismiss: (() -> Void)?
    var sheet: () -> C
    @State private var token: SheetToken?

    func body(content: Content) -> some View {
        content
            .onChange(of: isPresented) { _, v in token = v ? (token ?? SheetToken()) : nil }
            .onAppear { if isPresented { token = SheetToken() } }
            .bottomSheet(item: $token, onDismiss: { if isPresented { isPresented = false }; onDismiss?() }) { _ in sheet() }
    }
}

#Preview("Bottom sheet") {
    struct P: View {
        @State var open = true
        var body: some View {
            Button("Open") { open = true }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.default.page)
                .bottomSheet(isPresented: $open) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Connect to a device").font(.headline)
                        ForEach(0..<4, id: \.self) { Text("Device \($0)") }
                    }
                    .foregroundStyle(.white).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
        }
    }
    return P()
}
