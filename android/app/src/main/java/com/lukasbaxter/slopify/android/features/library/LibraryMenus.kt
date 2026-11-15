package com.lukasbaxter.slopify.android.features.library

import com.lukasbaxter.slopify.android.core.model.Playlist
import com.lukasbaxter.slopify.android.core.stores.GenerateRegenerate
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.sheets.MenuItem

/** Menu rows the library screens share, apart from their screens so they can be checked. */
internal object LibraryMenus {
    /**
     * Your Library's "+" sheet (Sidebar.jsx `createItems`, UI.md 5.2.10): a plain playlist, one
     * the server generates from a description, or a folder. No description lines on the phone.
     */
    fun create(onPlaylist: () -> Unit, onGenerate: () -> Unit, onFolder: () -> Unit): List<MenuItem> = listOf(
        MenuItem(L("Playlist"), Icon.Playlist, action = onPlaylist),
        MenuItem(L("Generated playlist (AI)"), Icon.Sparkle, action = onGenerate),
        MenuItem(L("Folder"), Icon.Folder, action = onFolder),
    )

    /**
     * "Regenerate" for a playlist that was generated (web `item.AiPrompt`): opens the Generate
     * dialog on it with what was asked last time. null for every other playlist.
     */
    fun regenerate(p: Playlist?, icon: Icon? = null, open: (GenerateRegenerate) -> Unit): MenuItem? {
        val prompt = p?.aiPrompt?.takeIf { it.isNotEmpty() } ?: return null
        return MenuItem(L("Regenerate"), icon) { open(GenerateRegenerate(p.id, prompt)) }
    }
}
