import SwiftUI

/// What album, playlist and Liked Songs pages share for "Download for offline" (UI.md 5.7.2,
/// 5.6.1 rows 8-9; Library.jsx:1256-1349): the tap, the remove confirm, the menu rows.
@MainActor
struct OfflineCollectionActions {
    let store: OfflineStore
    let id: String
    let name: String
    let kind: OfflineKind
    /// The page's songs now.
    let tracks: [Track]
    /// Presents a confirm (size over 1 GB, remove).
    var confirm: (ConfirmDialog) -> Void

    var held: OfflineSummary? { store.summary(id) }
    var busy: OfflineProgress? { store.busy(id) }
    var full: Bool { (held?.have ?? 0) >= tracks.count && held != nil && busy == nil }

    /// Download (or the rest); over 1 GB and not held asks first.
    func download() {
        let gb = store.estimateBytes(tracks) / 1e9
        if held == nil && gb > 1 {
            confirm(ConfirmDialog(message: L("{n} songs, about {gb} GB. Download for offline?", ["n": tracks.count, "gb": String(format: "%.1f", gb)]),
                                  confirm: L("Download")) { start() })
        } else {
            start()
        }
    }

    private func start() {
        let wasHeld = held != nil
        do {
            let when = try store.save(id: id, name: name, kind: kind, tracks: tracks)
            let text = when == .later ? L("You’re offline. It downloads when you’re back online.")
                : wasHeld ? L("Downloading the rest")
                : L("Downloading {n} songs. Keep Slopify open until it finishes.", ["n": tracks.count])
            ToastCenter.shared.show(text, seconds: 4)
        } catch {
            ToastCenter.shared.show((error as? LocalizedError)?.errorDescription ?? error.localizedDescription, seconds: 5)
        }
    }

    func remove() {
        let store = store, id = id
        confirm(ConfirmDialog(message: L("Remove the downloaded songs of \"{name}\" from this device?", ["name": name]),
                              confirm: L("Remove"), destructive: true) {
            store.remove(id)
            ToastCenter.shared.show(L("Download removed"))
        })
    }

    /// The page ⋯ rows 8-9, kept in the offline menu.
    var menuItems: [MenuItem] {
        guard !tracks.isEmpty else { return [] }
        var items: [MenuItem] = []
        if let held {
            let label = busy.map { L("Remove download ({done}/{total})", ["done": $0.done, "total": $0.total]) } ?? L("Remove download")
            items.append(MenuItem(label, icon: .trash, offline: true) { remove() })
            if held.have < tracks.count && busy == nil {
                items.append(MenuItem(L("Update download ({have}/{total})", ["have": held.have, "total": tracks.count]), icon: .download, offline: true) { download() })
            }
        } else {
            items.append(MenuItem(L("Download for offline"), icon: .download, offline: true) { download() })
        }
        return items
    }
}

/// The action-row download button: 40x40, the 24 pt glyph, green once anything is held, and
/// `{have}/{total}` under it while busy or partly held (outside the row's layout).
struct OfflineDownloadButton: View {
    let actions: OfflineCollectionActions
    @Environment(\.theme) private var theme

    var body: some View {
        let total = actions.tracks.count
        let held = actions.held, busy = actions.busy
        IconButton(on: held != nil, label: OfflineRules.label(held: held, busy: busy, pageTotal: total), action: {
            if busy != nil { return }
            if actions.full { actions.remove() } else { actions.download() }
        }) {
            DownloadGlyph(state: OfflineRules.glyph(held: held, busy: busy, pageTotal: total))
        }
        .overlay(alignment: .bottom) {
            if let count = OfflineRules.countLabel(held: held, busy: busy, pageTotal: total) {
                Text(verbatim: count)
                    .font(.system(size: 11)).monospacedDigit()
                    .foregroundStyle(theme.fgSub)
                    .fixedSize()
                    .alignmentGuide(.bottom) { d in d[.top] + 2 }
                    .allowsHitTesting(false)
            }
        }
    }
}

extension OfflineStore {
    /// Plays row `index` of `tracks`; offline only downloaded songs play (the list filtered to
    /// them), and a tap on another says so.
    func play(_ tracks: [Track], at index: Int, context: String?, player: Player) {
        guard let p = playable(tracks, at: index) else {
            ToastCenter.shared.show(L("Offline: only downloaded songs play"))
            return
        }
        player.play(p.tracks, startAt: p.index, context: context)
    }

    /// A page's play button.
    func playPage(_ tracks: [Track], context: String?, player: Player) {
        guard let list = OfflineRules.playablePage(tracks, offline: isOffline(), has: has) else {
            if isOffline() && !tracks.isEmpty { ToastCenter.shared.show(L("Offline: only downloaded songs play")) }
            return
        }
        player.play(list, startAt: 0, context: context)
    }

    /// A row is greyed out: offline and not downloaded.
    func unavailable(_ trackId: String) -> Bool { isOffline() && !has(trackId) }
}
