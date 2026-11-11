package com.lukasbaxter.slopify.android.features.library

import com.lukasbaxter.slopify.android.core.model.Album
import com.lukasbaxter.slopify.android.core.model.Artist
import com.lukasbaxter.slopify.android.core.model.LibraryLayout
import com.lukasbaxter.slopify.android.core.model.Playlist

/** One row of Your Library (Sidebar.jsx `all` / folder entries). */
data class LibraryEntry(
    val id: String,
    val kind: Kind,
    val name: String,
    val playlist: Playlist? = null,
    val album: Album? = null,
    val artist: Artist? = null,
    /** Folder picture hash (only when one was uploaded). */
    val folderCover: String? = null,
    /** Set on a folder's child shown under its open folder (`.libitem.infolder`). */
    val parent: String? = null,
) {
    enum class Kind { Playlist, Album, Artist, Folder }

    companion object {
        fun of(p: Playlist) = LibraryEntry(p.id, Kind.Playlist, p.name, playlist = p)
        fun of(a: Album) = LibraryEntry(a.id, Kind.Album, a.name, album = a)
        fun of(a: Artist) = LibraryEntry(a.id, Kind.Artist, a.name, artist = a)
    }
}

/** The chip filter (`libFilter`). */
enum class LibraryFilter(val kind: LibraryEntry.Kind) {
    Playlist(LibraryEntry.Kind.Playlist),
    Album(LibraryEntry.Kind.Album),
    Artist(LibraryEntry.Kind.Artist),
}

/**
 * What is saved, in the server's order (Sidebar.jsx:100-127; ios LibraryArrangement.swift).
 * Pure, so it is tested 1:1 against the web's algorithm.
 */
class LibraryArrangement(playlists: List<Playlist>, albums: List<Album>, artists: List<Artist>, layout: LibraryLayout?, pinned: List<String>) {
    /** Top-level rows in display order (pinned first). */
    val top: List<LibraryEntry>
    /** Each folder's children that are in the library. */
    val kids: Map<String, List<LibraryEntry>>
    /** Every known entry by id, folders included. */
    val byId: Map<String, LibraryEntry>

    init {
        val all = playlists.map(LibraryEntry::of) + albums.map(LibraryEntry::of) + artists.map(LibraryEntry::of)
        val by = LinkedHashMap<String, LibraryEntry>()
        for (e in all) if (e.id !in by) by[e.id] = e
        val lay = layout ?: LibraryLayout(emptyList(), emptyList())
        val k = LinkedHashMap<String, List<LibraryEntry>>()
        val placed = HashSet<String>()
        for (f in lay.folders) {
            val unique = f.items.filter { by[it] != null && it !in placed }.distinct()
            placed += unique
            k[f.id] = unique.mapNotNull { by[it] }
            by[f.id] = LibraryEntry(f.id, LibraryEntry.Kind.Folder, f.name, folderCover = f.cover)
        }
        val known = ArrayList<LibraryEntry>()
        for (id in lay.order) {
            val e = by[id]
            if (e != null && id !in placed) { placed += id; known += e }
        }
        // Folders the order does not mention go to the top (unshift: last one first).
        for (f in lay.folders) if (f.id !in placed) { placed += f.id; known.add(0, by.getValue(f.id)) }
        val freshSeen = HashSet<String>()
        val fresh = all.filter { it.id !in placed && freshSeen.add(it.id) }
        val pin = pinned.toSet()
        val list = fresh + known
        top = list.filter { it.id in pin } + list.filter { it.id !in pin }
        kids = k
        byId = by
    }

    /** The rows to show, without Liked Songs. */
    fun shown(filter: LibraryFilter?, query: String, offline: Boolean, downloaded: Set<String>, openFolders: Set<String>, shut: Boolean): List<LibraryEntry> {
        if (isFlat(filter, query, offline)) {
            return top.flatMap { if (it.kind == LibraryEntry.Kind.Folder) kids[it.id].orEmpty() else listOf(it) }
                .filter { e -> (filter == null || e.kind == filter.kind) && matches(e.name, query) && (!offline || e.id in downloaded) }
        }
        return top.flatMap { e ->
            if (e.kind != LibraryEntry.Kind.Folder || e.id !in openFolders || shut) listOf(e)
            else listOf(e) + kids[e.id].orEmpty().map { it.copy(parent = e.id) }
        }
    }

    // Editing (Sidebar.jsx `current` / `asLayout`)

    /** The arrangement as shown, ready to change and send. */
    data class Draft(
        val order: List<String>,
        val folders: Map<String, List<String>>,
        /** Folder ids in layout order (JS object key order). */
        val folderIds: List<String>,
        val names: Map<String, String>,
        val covers: Map<String, String>,
    ) {
        val layout: LibraryLayout
            get() = LibraryLayout(order, folderIds.mapNotNull { id -> folders[id]?.let { LibraryLayout.Folder(id, names[id] ?: "", covers[id], it) } })
    }

    /** Every folder's things (shown or not), and ids the server had that are not shown (yet). */
    fun draft(layout: LibraryLayout?): Draft {
        val lay = layout ?: LibraryLayout(emptyList(), emptyList())
        val order = top.map { it.id }.toMutableList()
        for (id in lay.order) if (id !in order && byId[id] == null) order += id
        val folders = LinkedHashMap<String, List<String>>()
        for (f in lay.folders) {
            val list = kids[f.id].orEmpty().map { it.id }.toMutableList()
            for (id in f.items) if (id !in list && byId[id] == null) list += id
            folders[f.id] = list
        }
        val names = HashMap<String, String>()
        val covers = HashMap<String, String>()
        for (f in lay.folders) { names[f.id] = f.name; f.cover?.let { covers[f.id] = it } }
        return Draft(order, folders, lay.folders.map { it.id }.distinct(), names, covers)
    }

    /**
     * Sidebar.jsx `onDrop`. `rows` = the drag rows' ids in order at lift (Liked Songs is not one),
     * `to` = the slot among them, `into` = the folder it was let go on.
     */
    fun dropping(d: Draft, id: String, to: Int, into: String?, rows: List<String>, shown: List<LibraryEntry>, openFolders: Set<String>, shut: Boolean): Draft {
        val meta = shown.associateBy { it.id }
        val dragged = meta[id]
        val order = d.order.filter { it != id }.toMutableList()
        val folders = LinkedHashMap(d.folders.mapValues { (_, v) -> v.filter { it != id } })
        if (into != null) {
            folders[into] = listOf(id) + folders[into].orEmpty()
            return d.copy(order = order, folders = folders)
        }
        val others = rows.filter { it != id }
        val prev = others.getOrNull(to - 1)
        val next = others.getOrNull(to)
        val pm = prev?.let { meta[it] }
        val nm = next?.let { meta[it] }
        val parent = nm?.parent
        val parentList = parent?.let { folders[it] }
        val isFolder = dragged?.kind == LibraryEntry.Kind.Folder
        if (parent != null && !isFolder && parentList != null) {
            // Between two of a folder's things (or before its first): in the folder.
            val list = parentList.toMutableList()
            val at = list.indexOf(next).takeIf { it >= 0 } ?: list.size
            list.add(at, id)
            folders[parent] = list
        } else if (pm != null && pm.kind == LibraryEntry.Kind.Folder && pm.id in openFolders && !shut && !isFolder && nm?.parent == null && kids[pm.id].isNullOrEmpty()) {
            // Right under an open, empty folder: in it.
            folders[pm.id] = listOf(id)
        } else {
            // At the top level, after the thing above it (or the folder that holds it).
            val anchor = pm?.let { it.parent ?: it.id }
            val i = anchor?.let { order.indexOf(it) } ?: -1
            if (i >= 0) order.add(i + 1, id) else order.add(0, id)
        }
        return d.copy(order = order, folders = folders)
    }

    companion object {
        /** Flat mode: a filter, a query or offline (Sidebar.jsx:268). */
        fun isFlat(filter: LibraryFilter?, query: String, offline: Boolean): Boolean =
            filter != null || normalizedQuery(query).isNotEmpty() || offline

        fun normalizedQuery(q: String): String = q.trim().lowercase()

        fun matches(name: String, query: String): Boolean {
            val q = normalizedQuery(query)
            return q.isEmpty() || name.lowercase().contains(q)
        }

        /** Liked Songs row: no filter or Playlists, matches its localized name, downloaded when offline. */
        fun showLiked(filter: LibraryFilter?, query: String, likedName: String, offline: Boolean, likedDownloaded: Boolean): Boolean =
            (filter == null || filter == LibraryFilter.Playlist) && matches(likedName, query) && (!offline || likedDownloaded)

        /** New folder at the very top, optimistic (`fd_new…` until the server answers). */
        fun creatingFolder(d: Draft, tempId: String, name: String): Draft = d.copy(
            order = listOf(tempId) + d.order,
            folders = d.folders + (tempId to emptyList()),
            names = d.names + (tempId to name),
            folderIds = if (tempId in d.folderIds) d.folderIds else d.folderIds + tempId,
        )

        fun renamingFolder(d: Draft, id: String, name: String): Draft = d.copy(names = d.names + (id to name))

        /** What it held goes back where the folder was; none of it is deleted. */
        fun deletingFolder(d: Draft, id: String): Draft {
            val held = d.folders[id].orEmpty()
            return d.copy(
                order = d.order.flatMap { if (it == id) held else listOf(it) },
                folders = d.folders - id,
                folderIds = d.folderIds.filter { it != id },
                names = d.names - id,
                covers = d.covers - id,
            )
        }

        fun togglingPin(pinned: List<String>, id: String): List<String> = if (id in pinned) pinned.filter { it != id } else pinned + id
    }
}

/** Which empty block the list shows (Sidebar.jsx:461-495), null for none. */
sealed interface LibraryEmptyState {
    data object NothingDownloaded : LibraryEmptyState
    data object CreateFirst : LibraryEmptyState
    data class NoMatch(val query: String) : LibraryEmptyState
    data object NoArtists : LibraryEmptyState
    data object NoAlbums : LibraryEmptyState

    companion object {
        fun pick(
            offline: Boolean, showLiked: Boolean, shownCount: Int, query: String, filter: LibraryFilter?,
            loading: Boolean, settled: Boolean, likedCountKnown: Boolean,
        ): LibraryEmptyState? {
            val q = LibraryArrangement.normalizedQuery(query)
            if (offline && !showLiked && shownCount == 0 && q.isEmpty()) return NothingDownloaded
            if (!offline && shownCount == 0 && !loading && settled && likedCountKnown && q.isEmpty() && (filter == null || filter == LibraryFilter.Playlist)) return CreateFirst
            if (q.isNotEmpty() && !showLiked && shownCount == 0) return NoMatch(query.trim())
            if (q.isEmpty() && !offline && filter == LibraryFilter.Artist && shownCount == 0 && !loading) return NoArtists
            if (q.isEmpty() && !offline && filter == LibraryFilter.Album && shownCount == 0 && !loading) return NoAlbums
            return null
        }
    }
}
