import SwiftUI

/// Phone context menu = bottom sheet (UI.md 5.5). Optional header, rows with 16 pt icons
/// (`--fg-dim`; the slot disappears when no row has an icon), danger / disabled / checked rows,
/// separators and headings. A row with `sub` opens a second sheet over the first (no header,
/// at least 45 % tall, no animation); tapping the scrim closes both; any action closes
/// everything first and then runs.
///
///     @State var menu: MenuSheet?
///     ...
///     .contextMenuSheet($menu)
///     menu = MenuSheet(header: .init(art: .cover(.init(track)), title: track.title, subtitle: artists),
///                      items: [MenuItem(L("Add to queue"), icon: .queue) { ... }])
struct ContextMenuSheet: View {
    var menu: MenuSheet
    @State private var sub: [MenuItem]?
    @Environment(\.closeSheet) private var closeSheet

    var body: some View {
        ZStack(alignment: .bottom) {
            BottomSheetFrame {
                MenuList(header: menu.header, items: menu.items, onPick: pick)
            }
            if let sub {
                BottomSheetFrame(sub: true) {
                    MenuList(header: nil, items: sub, onPick: pick)
                }
                .id(sub.first?.id)
            }
        }
    }

    private func pick(_ item: MenuItem) {
        guard !item.disabled, item.kind == .action else { return }
        if let s = item.sub { sub = s; return }
        closeSheet { item.action?() }
    }
}

/// The rows of a menu, for use inside any sheet (settings option sheets reuse it).
struct MenuList: View {
    var header: MenuHeader?
    var items: [MenuItem]
    var onPick: (MenuItem) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let hasIcons = items.contains { $0.icon != nil }
        VStack(alignment: .leading, spacing: 0) {
            if let header { headerView(header) }
            ForEach(items) { it in
                switch it.kind {
                case .separator:
                    Rectangle().fill(theme.fg(0.14)).frame(height: 1).padding(.vertical, 4)
                case .heading:
                    Text(it.label).textStyle(.menuHeading).foregroundStyle(theme.fgDim)
                        .padding(.top, 8).padding(.horizontal, 12).padding(.bottom, 4)
                case .action:
                    row(it, iconSlot: hasIcons)
                }
            }
        }
    }

    private func headerView(_ h: MenuHeader) -> some View {
        HStack(spacing: 12) {
            Group {
                switch h.art {
                case .cover(let src, let round):
                    CoverImage(src, size: 56, shape: round ? .circle : .rounded(Radius.art))
                case .liked: LikedCover()
                case .icon(let i): IconView(i, size: 24).foregroundStyle(theme.fg)
                case .none: EmptyView()
                }
            }
            .frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 2) {
                Text(h.title).textStyle(.barTitle).foregroundStyle(theme.fg).lineLimit(1)
                if let s = h.subtitle, !s.isEmpty {
                    Text(s).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 14).padding(.horizontal, 12).padding(.bottom, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(theme.fg(0.1)).frame(height: 1) }
        .padding(.bottom, 6)
        .accessibilityElement(children: .combine)
    }

    private func row(_ it: MenuItem, iconSlot: Bool) -> some View {
        let color = it.danger ? theme.danger : theme.fg
        return Button { onPick(it) } label: {
            HStack(spacing: 12) {
                if iconSlot {
                    Group { if let i = it.icon { IconView(i, size: 16) } else { Color.clear } }
                        .frame(width: 16, height: 16)
                        .foregroundStyle(it.danger ? theme.danger : theme.fgDim)
                }
                Text(it.label).font(.system(size: 16)).foregroundStyle(color).lineLimit(1)
                Spacer(minLength: 0)
                if it.checked { IconView(.menuCheck, size: 16).foregroundStyle(theme.accentInk) }
            }
            .padding(.vertical, 14).padding(.horizontal, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(MenuRowStyle())
        .disabled(it.disabled)
        .opacity(it.disabled ? 0.4 : 1)
        .accessibilityAddTraits(it.checked ? .isSelected : [])
    }
}

private struct MenuRowStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? theme.fg(0.08) : .clear, in: RoundedRectangle(cornerRadius: 2))
    }
}

extension View {
    /// Present a context-menu sheet over everything while `menu` is non-nil.
    func contextMenuSheet(_ menu: Binding<MenuSheet?>) -> some View {
        overlayCover(item: menu) { m, dismiss in
            SheetHost(dismiss: dismiss) { ContextMenuSheet(menu: m) }
        }
    }
}

#Preview("Context menu") {
    struct P: View {
        @State var menu: MenuSheet? = MenuSheet(
            header: MenuHeader(art: .cover(.url(nil)), title: "Paranoid Android", subtitle: "Radiohead"),
            items: [
                MenuItem("Add to queue", icon: .queue, offline: true) {},
                MenuItem("Add to playlist", icon: .plus, sub: [MenuItem("New playlist", icon: .plus) {}, .separator, MenuItem("Road trip") {}]),
                MenuItem("Add to Liked Songs", icon: .heart) {},
                .separator,
                MenuItem("Go to artist", icon: .artist, offline: true) {},
                MenuItem("Syncing Lyrics…", icon: .lyrics, disabled: true),
                MenuItem("Delete", icon: .trash, danger: true) {},
            ])
        var body: some View {
            Button("Open") { menu = MenuSheet(items: [MenuItem("Original", checked: true) {}, MenuItem("FLAC") {}]) }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.default.page)
                .contextMenuSheet($menu)
        }
    }
    return P()
}
