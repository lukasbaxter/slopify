import SwiftUI

/// Presents `content` full screen above everything (tab bar, mini player, now playing) with a
/// clear background and no system animation, so the content can run the web's own
/// scrim fade and slide. Used by sheets and dialogs. Touches never reach the page behind.
struct OverlayCover<Item: Identifiable, Overlay: View>: ViewModifier {
    @Binding var item: Item?
    var onDismiss: (() -> Void)? = nil
    @ViewBuilder var overlay: (Item, _ close: @escaping (_ then: (() -> Void)?) -> Void) -> Overlay

    @State private var shown: Item?
    @State private var after: (() -> Void)?

    func body(content: Content) -> some View {
        content
            .onChange(of: item?.id) { _, id in
                let next = id == nil ? nil : item
                if (next == nil) != (shown == nil) || next?.id != shown?.id { set(next) }
            }
            .onAppear { if item != nil { set(item) } }
            .fullScreenCover(item: $shown, onDismiss: {
                let run = after; after = nil
                if item != nil { item = nil }
                onDismiss?()
                run?()
            }) { it in
                overlay(it) { then in
                    after = then
                    set(nil)
                }
                .presentationBackground(.clear)
            }
    }

    private func set(_ v: Item?) {
        var t = Transaction()
        t.disablesAnimations = true
        withTransaction(t) { shown = v }
    }
}

extension View {
    /// Full-screen transparent presentation without the system slide (sheets, dialogs).
    /// `close(then:)` dismisses and runs `then` once the cover is gone.
    func overlayCover<Item: Identifiable, Overlay: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil,
                                                         @ViewBuilder overlay: @escaping (Item, _ close: @escaping (_ then: (() -> Void)?) -> Void) -> Overlay) -> some View {
        modifier(OverlayCover(item: item, onDismiss: onDismiss, overlay: overlay))
    }
}
