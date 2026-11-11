package com.lukasbaxter.slopify.android.design.image

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Cache-bust for the signed-in user's picture after an upload (web `avatarV`): every [Avatar]
 * asks for `?v=<upload time>` once [bumped], so the header and drawer show the new photo.
 */
object AvatarVersion {
    /** Upload time in ms; null until this run uploads one. */
    var bust by mutableStateOf<Long?>(null)
        private set

    fun bumped() { bust = System.currentTimeMillis() }
}
