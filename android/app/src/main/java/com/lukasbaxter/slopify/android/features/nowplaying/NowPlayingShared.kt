package com.lukasbaxter.slopify.android.features.nowplaying

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.model.Format
import com.lukasbaxter.slopify.android.core.model.Track
import com.lukasbaxter.slopify.android.core.session.SessionState
import com.lukasbaxter.slopify.android.design.components.DeliveredFormat
import com.lukasbaxter.slopify.android.design.icons.RepeatGlyphMode
import com.lukasbaxter.slopify.android.design.icons.ShuffleGlyphMode
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.player.DeliveredProfile
import com.lukasbaxter.slopify.android.player.PlayerState
import com.lukasbaxter.slopify.android.player.RepeatMode
import com.lukasbaxter.slopify.android.player.ShuffleMode

/**
 * What the player screens read from the player and the session together (ios
 * NowPlayingSession). Pure: built from the two states, so tests construct it directly.
 * `downloaded` answers whether this phone plays a track from a local file.
 */
class NowPlayingSession(
    val player: PlayerState,
    val session: SessionState,
    private val downloaded: (String) -> Boolean = { false },
) {
    val devices: List<NowPlayingDevice> by lazy { NowPlayingDevices.devices(session.players, session.lanDevices) }

    /** The device the session is on (Player.jsx `sessionDeviceOf`). */
    val active: NowPlayingDevice by lazy {
        NowPlayingDevices.sessionDevice(session.activeClientId, session.clientId, session.players, devices)
    }

    /** Green state: the session is not on this phone. */
    val casting: Boolean get() = active.kind != "local"

    /** "Playing on {name}" target, null when the sound is here. */
    val elsewhere: String? get() = NowPlayingDevices.elsewhereLabel(session.activeClientId, session.clientId, session.players)

    /** Mirroring another client. */
    val mirroring: Boolean get() = player.remoteClientId != null

    /** Calibrated output delay of the session's speaker, seconds (`useOffset`). */
    val speakerDelay: Double
        get() {
            val a = session.activeClientId ?: return 0.0
            if (a == session.clientId) return 0.0
            val d = session.players.firstOrNull { it.id == a }?.nowPlaying?.device ?: return 0.0
            if (!NowPlayingDevices.isSpeaker(d)) return 0.0
            return session.offsets[d.id] ?: 0.0
        }

    /**
     * The quality line (QualityBadge.jsx `deliveredFormat`): speakers and other clients get the
     * original; this phone what the stream profile delivers.
     */
    fun deliveredFormat(track: Track?): Format? {
        track ?: return null
        if (casting) return DeliveredFormat.delivered(track.format, active.kind)
        val live = if (track.id == player.current?.id) player.deliveredProfile else null
        val profile = live ?: if (downloaded(track.id)) DeliveredProfile.File else null
        return when (profile) {
            DeliveredProfile.File -> DeliveredFormat.delivered(track.format, "local", DeliveredFormat.Mode.File)
            is DeliveredProfile.Hls -> DeliveredFormat.delivered(track.format, "local", DeliveredFormat.Mode.Hls, profile.profile)
            null -> DeliveredFormat.delivered(track.format, "local", DeliveredFormat.Mode.Hls)
        }
    }
}

/** The live [NowPlayingSession] for a screen. */
@Composable
internal fun rememberNowPlayingSession(): NowPlayingSession {
    val app = LocalAppModel.current
    val p by app.player.state.collectAsStateWithLifecycle()
    val s by app.session.state.collectAsStateWithLifecycle()
    val player = app.player
    return NowPlayingSession(p, s) { id -> player.localFile?.invoke(id) != null }
}

object NowPlayingCover {
    /** A track's cover. Mirrored tracks may lack an album id: fall back to the track's own picture. */
    fun source(t: Track): CoverSource = CoverSource.TrackArt(t.id, t.albumId.ifEmpty { null }, t.cover)
}

/** off -> on -> smart -> off (usePlayer.js:1382-1394). */
val ShuffleMode.nowPlayingNext: ShuffleMode
    get() = when (this) {
        ShuffleMode.Off -> ShuffleMode.On
        ShuffleMode.On -> ShuffleMode.Smart
        ShuffleMode.Smart -> ShuffleMode.Off
    }

val ShuffleMode.nowPlayingGlyph: ShuffleGlyphMode
    get() = when (this) {
        ShuffleMode.Off -> ShuffleGlyphMode.Off
        ShuffleMode.On -> ShuffleGlyphMode.On
        ShuffleMode.Smart -> ShuffleGlyphMode.Smart
    }

/** off -> all -> one -> off. */
val RepeatMode.nowPlayingNext: RepeatMode
    get() = when (this) {
        RepeatMode.Off -> RepeatMode.All
        RepeatMode.All -> RepeatMode.One
        RepeatMode.One -> RepeatMode.Off
    }

val RepeatMode.nowPlayingGlyph: RepeatGlyphMode
    get() = when (this) {
        RepeatMode.Off -> RepeatGlyphMode.Off
        RepeatMode.All -> RepeatGlyphMode.All
        RepeatMode.One -> RepeatGlyphMode.One
    }

/** The artist line's parts: each credit with its id, or one fallback name (TrackRow.jsx:82-103). */
internal fun nowPlayingArtistParts(t: Track): List<Pair<String, String?>> {
    val credits = t.artistCredits
    if (credits.isEmpty() || credits.all { it.id == null }) {
        return listOf(t.artist.ifEmpty { t.albumArtist } to t.artistIds.firstOrNull())
    }
    return credits.map { it.name to it.id }
}

/** `NowPlayingArtistLinks`: each artist its own tappable name, ", " between, one line. */
@Composable
internal fun NowPlayingArtistLinks(track: Track, style: TextStyle, color: Color, modifier: Modifier = Modifier, onArtist: (String) -> Unit) {
    val parts = nowPlayingArtistParts(track)
    val text = buildAnnotatedString {
        parts.forEachIndexed { i, (name, id) ->
            if (id != null) withLink(LinkAnnotation.Clickable("artist:$i") { onArtist(id) }) { append(name) } else append(name)
            if (i < parts.size - 1) append(", ")
        }
    }
    Text(text, modifier, style = style, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}
