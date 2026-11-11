import Foundation

/// One row of the "Connect to a device" sheet (DevicePicker.jsx; UI.md 4.1, 4.3).
struct NowPlayingDevice: Hashable, Identifiable, Sendable {
    var id: String
    /// local, relay, cast, bluos, bridge, upnp, airplay, roku, tv
    var kind: String
    var name: String
    /// Translation key or raw model ("Laptop", "Chromecast", a speaker model).
    var model: String
    var form: String?
    /// Relay rows: the other client's id.
    var relayClientId: String?
    /// Speakers: who drives it, and its Slopify speaker group (itself first).
    var viaClient: String?
    var group: [String]?
    /// Session device on a speaker group: every speaker the music is on.
    var playingOn: [String]?
    var lan: LanDevice?

    /// `LOCAL_DEVICE` in the phone app (usePlayer.js:129-134).
    static let local = NowPlayingDevice(id: "local", kind: "local", name: "This Phone", model: "Phone playback")
}

enum NowPlayingDevices {
    /// `SPEAKER_TV`: speakers that are really TVs.
    static func looksLikeTV(kind: String, model: String?) -> Bool {
        let s = "\(kind) \(model ?? "")".lowercased()
        if s.hasPrefix("roku ") { return true }
        for k in ["appletv", "apple tv", "television", "bravia", "webos", "tizen", "viera"] where s.contains(k) { return true }
        return s.range(of: #"\btv\b"#, options: .regularExpression) != nil
    }

    /// `FORM_MODEL` / `modelOfClient`.
    static func clientModel(_ p: RosterPlayer) -> String {
        switch p.form {
        case "tv": return "Slopify TV"
        case "tablet": return "Tablet"
        case "phone": return "Phone"
        case "laptop": return "Laptop"
        case "desktop": return "Desktop"
        default: return p.kind == "desktop" ? "Desktop" : p.kind == "phone" ? "Phone" : "Slopify"
        }
    }

    /// Other Slopify clients that can play, in roster order (usePlayer.js:634-636).
    static func relays(_ players: [RosterPlayer]) -> [NowPlayingDevice] {
        players.filter { $0.canPlay == true }.map {
            NowPlayingDevice(id: "relay:\($0.id)", kind: "relay", name: $0.name, model: clientModel($0), form: $0.form, relayClientId: $0.id)
        }
    }

    /// Speakers and TVs in server order, de-duplicated by id (usePlayer.js:626-632).
    static func speakers(_ lan: [LanDevice]) -> [NowPlayingDevice] {
        var seen = Set<String>()
        return lan.compactMap { d in
            guard seen.insert(d.id).inserted else { return nil }
            let model: String
            switch d.kind {
            case "bluos": model = "Bluesound"
            case "bridge": model = d.model ?? "Speaker"
            case "tv": model = "Slopify TV"
            case "upnp": model = d.model ?? "DLNA"
            case "airplay": model = "AirPlay"
            case "roku": model = d.model ?? "Roku"
            default: model = "Chromecast"
            }
            return NowPlayingDevice(id: d.id, kind: d.kind, name: d.name, model: model,
                               form: looksLikeTV(kind: d.kind, model: d.model) ? "tv" : nil,
                               viaClient: d.viaClient, group: d.group, lan: d)
        }
    }

    /// The phone list: relay clients, then speakers (App.jsx:1802).
    static func devices(players: [RosterPlayer], lan: [LanDevice]) -> [NowPlayingDevice] {
        relays(players) + speakers(lan)
    }

    static func isSpeaker(_ d: OutputDevice?) -> Bool {
        guard let d else { return false }
        return d.kind != "local" && d.kind != "relay"
    }

    /// `sessionDeviceOf` (Player.jsx:174-188): the device the session is on.
    static func sessionDevice(activeId: String?, myId: String, players: [RosterPlayer], devices: [NowPlayingDevice]) -> NowPlayingDevice {
        guard let activeId, activeId != myId else { return .local }
        let active = players.first { $0.id == activeId }
        if let sp = active?.nowPlaying?.device, isSpeaker(sp) {
            var d = devices.first { $0.id == sp.id }
                ?? NowPlayingDevice(id: sp.id, kind: sp.kind, name: sp.name, model: "")
            d.playingOn = [sp.id] + (sp.members ?? [])
            return d
        }
        if let row = devices.first(where: { $0.kind == "relay" && $0.relayClientId == activeId }) { return row }
        return NowPlayingDevice(id: "relay:\(activeId)", kind: "relay", name: active?.name ?? "Slopify", model: "",
                           form: active?.form, relayClientId: activeId)
    }

    /// `elsewhereLabel` (Player.jsx:117-135): the name the sound is on, nil when it is here.
    static func elsewhereLabel(activeId: String?, myId: String, players: [RosterPlayer]) -> String? {
        guard let activeId, activeId != myId, let active = players.first(where: { $0.id == activeId }) else { return nil }
        if let sp = active.nowPlaying?.device, isSpeaker(sp) { return sp.name }
        return active.name
    }

    // MARK: Text (DevicePicker.jsx:155-191)

    static func nameFor(_ d: NowPlayingDevice) -> String { d.kind == "local" ? L(d.name) : d.name }

    static func label(_ d: NowPlayingDevice, in all: [NowPlayingDevice]) -> String {
        if let on = d.playingOn, on.count > 1 {
            return on.map { id in all.first { $0.id == id }?.name ?? id }.joined(separator: " + ")
        }
        return nameFor(d)
    }

    static func subtitle(_ d: NowPlayingDevice, in all: [NowPlayingDevice]) -> String {
        if let g = d.group, g.count > 1 {
            let names = g.dropFirst().map { id in all.first { $0.id == id }?.name ?? id }.joined(separator: ", ")
            return L("Grouped with {names}", ["names": names])
        }
        return d.model.isEmpty ? "" : L(d.model)
    }

    static func kindLabel(_ d: NowPlayingDevice) -> String {
        switch d.kind {
        case "local": return L("This phone")
        case "cast": return "Google Cast"
        case "bluos": return "Bluesound"
        case "bridge": return d.model.isEmpty ? L("Speaker") : L(d.model)
        case "airplay": return "AirPlay"
        case "upnp", "roku": return d.model
        default: return "Slopify"
        }
    }

    static func subline(_ d: NowPlayingDevice, in all: [NowPlayingDevice]) -> String {
        let s = subtitle(d, in: all)
        return s.isEmpty ? kindLabel(d) : s
    }

    /// `DeviceIcon` (DevicePicker.jsx:45-54) on the phone set.
    static func icon(_ d: NowPlayingDevice) -> Icon {
        let shape = d.form ?? (d.kind == "local" ? "phone" : d.kind == "tv" ? "tv" : nil)
        switch shape {
        case "phone": return .devicePhone
        case "laptop": return .deviceLaptop
        case "desktop": return .deviceDesktop
        case "tablet": return .deviceTablet
        case "tv": return .deviceTV
        default: break
        }
        switch d.kind {
        case "local": return .devicePhone
        case "cast": return .deviceCast
        case "bluos", "bridge", "upnp", "airplay": return .deviceSpeaker
        case "relay": return .deviceLaptop
        default: return .deviceCast
        }
    }

    /// `[LOCAL, ...devices]` minus every device the session is playing on.
    static func others(_ devices: [NowPlayingDevice], active: NowPlayingDevice) -> [NowPlayingDevice] {
        let playing = Set(active.playingOn ?? [active.id])
        return ([NowPlayingDevice.local] + devices).filter { !playing.contains($0.id) }
    }
}
