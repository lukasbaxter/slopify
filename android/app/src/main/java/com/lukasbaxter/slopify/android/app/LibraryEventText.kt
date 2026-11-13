package com.lukasbaxter.slopify.android.app

import com.lukasbaxter.slopify.android.core.stores.LibraryAction
import com.lukasbaxter.slopify.android.core.stores.LibraryEvent
import com.lukasbaxter.slopify.android.design.L

/** The toast for a library event, in the web's words (ios LibraryStore toasts). */
fun LibraryEvent.toastText(): String = when (this) {
    is LibraryEvent.Added -> L("Added to {name}", "name" to name)
    is LibraryEvent.AlreadyIn -> L("Already in {name}", "name" to name)
    is LibraryEvent.AddedSkipping -> L("Added {added} to {name}, skipped {skipped} already there", "name" to name, "added" to added, "skipped" to skipped)
    is LibraryEvent.Created -> L("Created {name}", "name" to name)
    is LibraryEvent.Deleted -> L("Deleted {name}", "name" to name)
    LibraryEvent.PlaylistUpdated -> L("Playlist updated")
    is LibraryEvent.Failed -> when (action) {
        LibraryAction.SaveLibrary -> L("Could not save Your Library: {error}", "error" to error)
        LibraryAction.CreatePlaylist -> L("Could not create playlist: {error}", "error" to error)
        LibraryAction.AddToPlaylist -> L("Could not add: {error}", "error" to error)
        LibraryAction.DeletePlaylist -> L("Could not delete: {error}", "error" to error)
        LibraryAction.UpdatePlaylist -> L("Could not update playlist: {error}", "error" to error)
    }
}
