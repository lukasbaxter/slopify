import SwiftUI

/// One row of a context-menu sheet (ContextMenu.jsx; UI.md 5.5.3).
struct MenuItem: Identifiable {
    enum Kind { case action, separator, heading }

    let id = UUID()
    var kind: Kind = .action
    var label: String = ""
    var icon: Icon? = nil
    /// Red text and icon (`--danger`): Delete.
    var danger = false
    /// 40 %, not tappable.
    var disabled = false
    /// Green check at the right (selected option).
    var checked = false
    /// Tapping opens a second sheet with these rows instead of running `action`.
    var sub: [MenuItem]? = nil
    /// Kept in the offline menu (TrackRow.jsx / Library.jsx `offline` flag).
    var offline = false
    /// Runs after the sheet has closed.
    var action: (() -> Void)? = nil

    init(_ label: String, icon: Icon? = nil, danger: Bool = false, disabled: Bool = false, checked: Bool = false,
         offline: Bool = false, sub: [MenuItem]? = nil, action: (() -> Void)? = nil) {
        self.label = label; self.icon = icon; self.danger = danger; self.disabled = disabled; self.checked = checked
        self.offline = offline; self.sub = sub; self.action = action
    }

    private init(kind: Kind, label: String = "") { self.kind = kind; self.label = label }

    static var separator: MenuItem { MenuItem(kind: .separator) }
    /// A label without action (12/700 `--fg-dim`).
    static func heading(_ label: String) -> MenuItem { MenuItem(kind: .heading, label: label) }

    /// Drop separators that lead, trail or double (TrackRow.jsx / Library.jsx `heroOffline`).
    static func tidy(_ items: [MenuItem]) -> [MenuItem] {
        var out: [MenuItem] = []
        for it in items {
            if it.kind == .separator && (out.isEmpty || out.last?.kind == .separator) { continue }
            out.append(it)
        }
        while out.last?.kind == .separator { out.removeLast() }
        return out
    }

    /// The offline subset: rows marked `offline`, separators tidied ("Menus reduce correctly offline").
    static func offlineSubset(_ items: [MenuItem]) -> [MenuItem] {
        tidy(items.filter { $0.kind == .separator || $0.offline }.map { it in
            var it = it
            if let s = it.sub { it.sub = offlineSubset(s) }
            return it
        })
    }
}

/// Sheet header (UI.md 5.5.2): 56 pt image (round for artists) or a custom tile, title, sub.
struct MenuHeader {
    enum Art {
        case cover(CoverSource, round: Bool = false)
        case liked
        case icon(Icon)
        case none
    }
    var art: Art = .none
    var title: String
    var subtitle: String? = nil
}

/// What a context-menu sheet shows. Present with `.contextMenuSheet($menu)`.
struct MenuSheet: Identifiable {
    let id = UUID()
    var header: MenuHeader? = nil
    var items: [MenuItem]
}
