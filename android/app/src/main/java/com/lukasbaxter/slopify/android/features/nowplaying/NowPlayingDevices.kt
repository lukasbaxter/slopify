package com.lukasbaxter.slopify.android.features.nowplaying

import com.lukasbaxter.slopify.android.core.session.LanDevice
import com.lukasbaxter.slopify.android.core.session.OutputDevice
import com.lukasbaxter.slopify.android.core.session.RosterPlayer
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon

/** One row of the "Connect to a device" sheet (DevicePicker.jsx; UI.md 4.1, 4.3). */
data class NowPlayingDevice(
    val id: String,
    /** local, relay, cast, bluos, bridge, upnp, airplay, roku, tv */
    val kind: String,
    val name: String,
    /** Translation key or raw model ("Laptop", "Chromecast", a speaker model). */
    val model: String,
    val form: String? = null,
    /** Relay rows: the other client's id. */
    val relayClientId: String? = null,
    /** Speakers: who drives it, and its Slopify speaker group (itself first). */
    val viaClient: String? = null,
    val group: List<String>? = null,
    /** Session device on a speaker group: every speaker the music is on. */
    val playingOn: List<String>? = null,
    val lan: LanDevice? = null,
) {
    companion object {
        /** `LOCAL_DEVICE` in the phone app (usePlayer.js:129-134). Name and model are locale keys. */
        val local = NowPlayingDevice(id = "local", kind = "local", name = "This Phone", model = "Phone playback")
    }
}

object NowPlayingDevices {
    private val tvWord = Regex("\\btv\\b")

    /** `SPEAKER_TV`: speakers that are really TVs. */
    fun looksLikeTV(kind: String, model: String?): Boolean {
        val s = "$kind ${model ?: ""}".lowercase()
        if (s.startsWith("roku ")) return true
        if (listOf("appletv", "apple tv", "television", "bravia", "webos", "tizen", "viera").any { s.contains(it) }) return true
        return tvWord.containsMatchIn(s)
    }

    /** `FORM_MODEL` / `modelOfClient`. */
    fun clientModel(p: RosterPlayer): String = when (p.form) {
        "tv" -> "Slopify TV"
        "tablet" -> "Tablet"
        "phone" -> "Phone"
        "laptop" -> "Laptop"
        "desktop" -> "Desktop"
        else -> if (p.kind == "desktop") "Desktop" else if (p.kind == "phone") "Phone" else "Slopify"
    }

    /** Other Slopify clients that can play, in roster order (usePlayer.js:634-636). */
    fun relays(players: List<RosterPlayer>): List<NowPlayingDevice> = players.filter { it.canPlay == true }.map {
        NowPlayingDevice(id = "relay:${it.id}", kind = "relay", name = it.name, model = clientModel(it), form = it.form, relayClientId = it.id)
    }

    /** Speakers and TVs in server order, de-duplicated by id (usePlayer.js:626-632). */
    fun speakers(lan: List<LanDevice>): List<NowPlayingDevice> {
        val seen = HashSet<String>()
        return lan.mapNotNull { d ->
            if (!seen.add(d.id)) return@mapNotNull null
            val model = when (d.kind) {
                "bluos" -> "Bluesound"
                "bridge" -> d.model ?: "Speaker"
                "tv" -> "Slopify TV"
                "upnp" -> d.model ?: "DLNA"
                "airplay" -> "AirPlay"
                "roku" -> d.model ?: "Roku"
                else -> "Chromecast"
            }
            NowPlayingDevice(
                id = d.id, kind = d.kind, name = d.name, model = model,
                form = if (looksLikeTV(d.kind, d.model)) "tv" else null,
                viaClient = d.viaClient, group = d.group, lan = d,
            )
        }
    }

    /** The phone list: relay clients, then speakers (App.jsx:1802). */
    fun devices(players: List<RosterPlayer>, lan: List<LanDevice>): List<NowPlayingDevice> = relays(players) + speakers(lan)

    fun isSpeaker(d: OutputDevice?): Boolean = d != null && d.kind != "local" && d.kind != "relay"

    /** `sessionDeviceOf` (Player.jsx:174-188): the device the session is on. */
    fun sessionDevice(activeId: String?, myId: String, players: List<RosterPlayer>, devices: List<NowPlayingDevice>): NowPlayingDevice {
        if (activeId == null || activeId == myId) return NowPlayingDevice.local
        val active = players.firstOrNull { it.id == activeId }
        val sp = active?.nowPlaying?.device
        if (sp != null && isSpeaker(sp)) {
            val d = devices.firstOrNull { it.id == sp.id } ?: NowPlayingDevice(id = sp.id, kind = sp.kind, name = sp.name, model = "")
            return d.copy(playingOn = listOf(sp.id) + (sp.members ?: emptyList()))
        }
        devices.firstOrNull { it.kind == "relay" && it.relayClientId == activeId }?.let { return it }
        return NowPlayingDevice(
            id = "relay:$activeId", kind = "relay", name = active?.name ?: "Slopify", model = "",
            form = active?.form, relayClientId = activeId,
        )
    }

    /** `elsewhereLabel` (Player.jsx:117-135): the name the sound is on, null when it is here. */
    fun elsewhereLabel(activeId: String?, myId: String, players: List<RosterPlayer>): String? {
        if (activeId == null || activeId == myId) return null
        val active = players.firstOrNull { it.id == activeId } ?: return null
        val sp = active.nowPlaying?.device
        if (sp != null && isSpeaker(sp)) return sp.name
        return active.name
    }

    // Text (DevicePicker.jsx:155-191)

    fun nameFor(d: NowPlayingDevice): String = if (d.kind == "local") L(d.name) else d.name

    fun label(d: NowPlayingDevice, all: List<NowPlayingDevice>): String {
        val on = d.playingOn
        if (on != null && on.size > 1) return on.joinToString(" + ") { id -> all.firstOrNull { it.id == id }?.name ?: id }
        return nameFor(d)
    }

    fun subtitle(d: NowPlayingDevice, all: List<NowPlayingDevice>): String {
        val g = d.group
        if (g != null && g.size > 1) {
            val names = g.drop(1).joinToString(", ") { id -> all.firstOrNull { it.id == id }?.name ?: id }
            return L("Grouped with {names}", "names" to names)
        }
        return if (d.model.isEmpty()) "" else L(d.model)
    }

    fun kindLabel(d: NowPlayingDevice): String = when (d.kind) {
        "local" -> L("This phone")
        "cast" -> "Google Cast"
        "bluos" -> "Bluesound"
        "bridge" -> if (d.model.isEmpty()) L("Speaker") else L(d.model)
        "airplay" -> "AirPlay"
        "upnp", "roku" -> d.model
        else -> "Slopify"
    }

    fun subline(d: NowPlayingDevice, all: List<NowPlayingDevice>): String = subtitle(d, all).ifEmpty { kindLabel(d) }

    /** `DeviceIcon` (DevicePicker.jsx:45-54) on the phone set. */
    fun icon(d: NowPlayingDevice): Icon {
        val shape = d.form ?: when (d.kind) {
            "local" -> "phone"
            "tv" -> "tv"
            else -> null
        }
        when (shape) {
            "phone" -> return Icon.DevicePhone
            "laptop" -> return Icon.DeviceLaptop
            "desktop" -> return Icon.DeviceDesktop
            "tablet" -> return Icon.DeviceTablet
            "tv" -> return Icon.DeviceTV
        }
        return when (d.kind) {
            "local" -> Icon.DevicePhone
            "cast" -> Icon.DeviceCast
            "bluos", "bridge", "upnp", "airplay" -> Icon.DeviceSpeaker
            "relay" -> Icon.DeviceLaptop
            else -> Icon.DeviceCast
        }
    }

    /** `[LOCAL, ...devices]` minus every device the session is playing on. */
    fun others(devices: List<NowPlayingDevice>, active: NowPlayingDevice): List<NowPlayingDevice> {
        val playing = (active.playingOn ?: listOf(active.id)).toSet()
        return (listOf(NowPlayingDevice.local) + devices).filter { it.id !in playing }
    }
}
