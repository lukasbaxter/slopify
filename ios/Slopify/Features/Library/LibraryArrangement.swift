import Foundation

/// One row of Your Library (Sidebar.jsx `all` / folder entries).
struct LibraryEntry: Identifiable, Hashable {
    enum Kind: String, Hashable, Sendable { case playlist, album, artist, folder }

    var id: String
    var kind: Kind
    var name: String
    var playlist: Playlist?
    var album: Album?
    var artist: Artist?
    /// Folder picture hash (only when one was uploaded).
    var folderCover: String?
    /// Set on a folder's child shown under its open folder (`.libitem.infolder`).
    var parent: String?

    static func of(_ p: Playlist) -> LibraryEntry { LibraryEntry(id: p.id, kind: .playlist, name: p.name, playlist: p) }
    static func of(_ a: Album) -> LibraryEntry { LibraryEntry(id: a.id, kind: .album, name: a.name, album: a) }
    static func of(_ a: Artist) -> LibraryEntry { LibraryEntry(id: a.id, kind: .artist, name: a.name, artist: a) }
}

/// The chip filter (`libFilter`).
enum LibraryFilter: String, CaseIterable, Hashable, Sendable {
    case playlist, album, artist
    var kind: LibraryEntry.Kind {
        switch self { case .playlist: .playlist; case .album: .album; case .artist: .artist }
    }
}

/// What is saved, in the server's order (Sidebar.jsx:100-127). Pure, so it is tested 1:1
/// against the web's algorithm.
struct LibraryArrangement {
    /// Top-level rows in display order (pinned first).
    var top: [LibraryEntry]
    /// Each folder's children that are in the library.
    var kids: [String: [LibraryEntry]]
    /// Every known entry by id, folders included.
    var byId: [String: LibraryEntry]

    init(playlists: [Playlist], albums: [Album], artists: [Artist], layout: LibraryLayout?, pinned: [String]) {
        let all = playlists.map(LibraryEntry.of) + albums.map(LibraryEntry.of) + artists.map(LibraryEntry.of)
        var by: [String: LibraryEntry] = [:]
        for e in all where by[e.id] == nil { by[e.id] = e }
        let lay = layout ?? LibraryLayout(order: [], folders: [])
        var kids: [String: [LibraryEntry]] = [:]
        var placed = Set<String>()
        for f in lay.folders {
            let list = f.items.filter { by[$0] != nil && !placed.contains($0) }
            var seen = Set<String>()
            let unique = list.filter { seen.insert($0).inserted }
            unique.forEach { placed.insert($0) }
            kids[f.id] = unique.compactMap { by[$0] }
            by[f.id] = LibraryEntry(id: f.id, kind: .folder, name: f.name, folderCover: f.cover)
        }
        var known: [LibraryEntry] = []
        for id in lay.order where by[id] != nil && !placed.contains(id) {
            placed.insert(id); known.append(by[id]!)
        }
        // Folders the order does not mention go to the top (unshift: last one first).
        for f in lay.folders where !placed.contains(f.id) {
            placed.insert(f.id); known.insert(by[f.id]!, at: 0)
        }
        var freshSeen = Set<String>()
        let fresh = all.filter { !placed.contains($0.id) && freshSeen.insert($0.id).inserted }
        let pin = Set(pinned)
        let list = fresh + known
        top = list.filter { pin.contains($0.id) } + list.filter { !pin.contains($0.id) }
        self.kids = kids
        byId = by
    }

    /// Flat mode: a filter, a query or offline (Sidebar.jsx:268).
    static func isFlat(filter: LibraryFilter?, query: String, offline: Bool) -> Bool {
        filter != nil || !normalizedQuery(query).isEmpty || offline
    }

    static func normalizedQuery(_ q: String) -> String { q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

    static func matches(_ name: String, query: String) -> Bool {
        let q = normalizedQuery(query)
        return q.isEmpty || name.lowercased().contains(q)
    }

    /// The rows to show, without Liked Songs.
    func shown(filter: LibraryFilter?, query: String, offline: Bool, downloaded: Set<String>, openFolders: Set<String>, shut: Bool) -> [LibraryEntry] {
        if Self.isFlat(filter: filter, query: query, offline: offline) {
            return top.flatMap { $0.kind == .folder ? (kids[$0.id] ?? []) : [$0] }
                .filter { e in
                    (filter == nil || e.kind == filter!.kind) && Self.matches(e.name, query: query) && (!offline || downloaded.contains(e.id))
                }
        }
        return top.flatMap { e -> [LibraryEntry] in
            guard e.kind == .folder, openFolders.contains(e.id), !shut else { return [e] }
            return [e] + (kids[e.id] ?? []).map { var k = $0; k.parent = e.id; return k }
        }
    }

    /// Liked Songs row: no filter or Playlists, matches its localized name, downloaded when offline.
    static func showLiked(filter: LibraryFilter?, query: String, likedName: String, offline: Bool, likedDownloaded: Bool) -> Bool {
        (filter == nil || filter == .playlist) && matches(likedName, query: query) && (!offline || likedDownloaded)
    }

    // MARK: - Editing (Sidebar.jsx `current` / `asLayout`)

    /// The arrangement as shown, ready to change and send.
    struct Draft: Equatable {
        var order: [String]
        var folders: [String: [String]]
        /// Folder ids in layout order (JS object key order).
        var folderIds: [String]
        var names: [String: String]
        var covers: [String: String]

        var layout: LibraryLayout {
            LibraryLayout(order: order, folders: folderIds.compactMap { id in
                folders[id].map { LibraryLayout.Folder(id: id, name: names[id] ?? "", cover: covers[id], items: $0) }
            })
        }
    }

    /// Every folder's things (shown or not), and ids the server had that are not shown (yet).
    func draft(layout: LibraryLayout?) -> Draft {
        let lay = layout ?? LibraryLayout(order: [], folders: [])
        var order = top.map(\.id)
        for id in lay.order where !order.contains(id) && byId[id] == nil { order.append(id) }
        var folders: [String: [String]] = [:]
        for f in lay.folders {
            var list = (kids[f.id] ?? []).map(\.id)
            for id in f.items where !list.contains(id) && byId[id] == nil { list.append(id) }
            folders[f.id] = list
        }
        var names: [String: String] = [:], covers: [String: String] = [:]
        for f in lay.folders { names[f.id] = f.name; if let c = f.cover { covers[f.id] = c } }
        var seen = Set<String>()
        return Draft(order: order, folders: folders, folderIds: lay.folders.map(\.id).filter { seen.insert($0).inserted }, names: names, covers: covers)
    }

    /// New folder at the very top, optimistic (`fd_new…` until the server answers).
    static func creatingFolder(_ d: Draft, tempId: String, name: String) -> Draft {
        var c = d
        c.order.insert(tempId, at: 0); c.folders[tempId] = []; c.names[tempId] = name
        if !c.folderIds.contains(tempId) { c.folderIds.append(tempId) }
        return c
    }

    static func renamingFolder(_ d: Draft, id: String, name: String) -> Draft {
        var c = d; c.names[id] = name; return c
    }

    /// What it held goes back where the folder was; none of it is deleted.
    static func deletingFolder(_ d: Draft, id: String) -> Draft {
        var c = d
        let held = c.folders[id] ?? []
        c.order = c.order.flatMap { $0 == id ? held : [$0] }
        c.folders[id] = nil
        c.folderIds.removeAll { $0 == id }
        c.names[id] = nil; c.covers[id] = nil
        return c
    }

    /// Sidebar.jsx `onDrop`. `rows` = the drag rows' ids in order at lift (Liked Songs is not one),
    /// `to` = the slot among them, `into` = the folder it was let go on.
    func dropping(_ d: Draft, id: String, to: Int, into: String?, rows: [String], shown: [LibraryEntry], openFolders: Set<String>, shut: Bool) -> Draft {
        var meta: [String: LibraryEntry] = [:]
        for e in shown { meta[e.id] = e }
        var c = d
        let dragged = meta[id]
        c.order.removeAll { $0 == id }
        for f in c.folders.keys { c.folders[f]?.removeAll { $0 == id } }
        if let into {
            c.folders[into] = [id] + (c.folders[into] ?? [])
            return c
        }
        let others = rows.filter { $0 != id }
        let prev = to - 1 >= 0 && to - 1 < others.count ? others[to - 1] : nil
        let next = to >= 0 && to < others.count ? others[to] : nil
        let pm = prev.flatMap { meta[$0] }, nm = next.flatMap { meta[$0] }
        if let parent = nm?.parent, dragged?.kind != .folder, var list = c.folders[parent], let next {
            // Between two of a folder's things (or before its first): in the folder.
            list.insert(id, at: list.firstIndex(of: next) ?? list.count)
            c.folders[parent] = list
        } else if let pm, pm.kind == .folder, openFolders.contains(pm.id), !shut, dragged?.kind != .folder, nm?.parent == nil, (kids[pm.id] ?? []).isEmpty {
            // Right under an open, empty folder: in it.
            c.folders[pm.id] = [id]
        } else {
            // At the top level, after the thing above it (or the folder that holds it).
            let anchor = pm.map { $0.parent ?? $0.id }
            if let anchor, let i = c.order.firstIndex(of: anchor) { c.order.insert(id, at: i + 1) }
            else if anchor != nil { c.order.insert(id, at: 0) }
            else { c.order.insert(id, at: 0) }
        }
        return c
    }

    // MARK: - Pins

    static func togglingPin(_ pinned: [String], id: String) -> [String] {
        pinned.contains(id) ? pinned.filter { $0 != id } : pinned + [id]
    }
}

/// Which empty block the list shows (Sidebar.jsx:461-495), nil for none.
enum LibraryEmptyState: Equatable {
    case nothingDownloaded
    case createFirst
    case noMatch(String)
    case noArtists
    case noAlbums

    static func pick(offline: Bool, showLiked: Bool, shownCount: Int, query: String, filter: LibraryFilter?,
                     loading: Bool, settled: Bool, likedCountKnown: Bool) -> LibraryEmptyState? {
        let q = LibraryArrangement.normalizedQuery(query)
        if offline && !showLiked && shownCount == 0 && q.isEmpty { return .nothingDownloaded }
        if !offline && shownCount == 0 && !loading && settled && likedCountKnown && q.isEmpty && (filter == nil || filter == .playlist) { return .createFirst }
        if !q.isEmpty && !showLiked && shownCount == 0 { return .noMatch(query.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if q.isEmpty && !offline && filter == .artist && shownCount == 0 && !loading { return .noArtists }
        if q.isEmpty && !offline && filter == .album && shownCount == 0 && !loading { return .noAlbums }
        return nil
    }
}
