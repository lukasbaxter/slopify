package com.lukasbaxter.slopify.android.features.library

import com.lukasbaxter.slopify.android.core.stores.LibraryState
import com.lukasbaxter.slopify.android.core.stores.LibraryStore

// The Library screen's arrangement maths on top of the core store (ios LibraryStore's
// `arrangement`, `saveArrangement`, `createFolder`, `renameFolder`, `deleteFolder`).

internal fun LibraryState.arrangement(pinned: List<String>) = LibraryArrangement(playlists, albums, artists, layout, pinned)

internal fun LibraryStore.saveArrangement(d: LibraryArrangement.Draft) = saveLayout(d.layout, d.order, d.folders)

internal fun LibraryStore.createFolder(name: String, a: LibraryArrangement, now: Long = System.currentTimeMillis()) {
    val tmp = "fd_new" + now.toString(36)
    createFolder(name, LibraryArrangement.creatingFolder(a.draft(state.value.layout), tmp, name).layout)
}

internal fun LibraryStore.renameFolder(id: String, name: String, a: LibraryArrangement) =
    renameFolder(id, name, LibraryArrangement.renamingFolder(a.draft(state.value.layout), id, name).layout)

internal fun LibraryStore.deleteFolder(id: String, a: LibraryArrangement) =
    deleteFolder(id, LibraryArrangement.deletingFolder(a.draft(state.value.layout), id).layout)

/** Tell the account's other devices (App.jsx `sendPrefs({_libraryChanged})`). */
internal fun LibraryStore.libraryChanged() { onLibraryChanged?.invoke() }
