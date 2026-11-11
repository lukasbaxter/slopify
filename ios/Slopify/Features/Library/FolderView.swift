import SwiftUI

/// A Your Library folder as its own page (`Route.folder`). The web's phone layout opens folders
/// in place (UI.md 5.2.9), so nothing in the library pushes this; it lists the folder's
/// things with the library rows for any link that does.
struct FolderView: View {
    let id: String

    @Environment(Navigator.self) private var nav
    @Environment(Account.self) private var account
    @Environment(Player.self) private var player
    @Environment(Likes.self) private var likes
    @Environment(SessionClient.self) private var session
    @Environment(\.theme) private var theme
    @State private var store = LibraryStore.shared

    private var ctx: LibraryContext { LibraryContext(api: account.api, account: account, player: player, likes: likes, nav: nav, session: session) }

    var body: some View {
        let a = store.arrangement(pinned: ctx.pinned)
        let pinned = Set(ctx.pinned)
        let folder = a.byId[id]
        DetailScaffold(title: folder?.name ?? L("Folder")) {
            Text(folder?.name ?? L("Folder")).textStyle(.pageTitle).foregroundStyle(theme.fg)
                .padding(.horizontal, Spacing.gutter).padding(.bottom, 8)
            LazyVStack(spacing: 0) {
                ForEach(a.kids[id] ?? []) { e in
                    LibraryListRow(model: LibraryRowModel(entry: e, subtitle: LibraryText.subtitle(e, folderCount: 0), pinned: pinned.contains(e.id)))
                        .pressable(.row, onTap: { open(e) })
                }
            }
            .padding(.horizontal, Spacing.gutter)
        }
        .task {
            ctx.attachStore()
            await store.refresh()
        }
    }

    private func open(_ e: LibraryEntry) {
        switch e.kind {
        case .playlist: nav.push(.playlist(id: e.id))
        case .album: nav.push(.album(id: e.id))
        case .artist: nav.push(.artist(id: e.id))
        case .folder: nav.push(.folder(id: e.id))
        }
    }
}
