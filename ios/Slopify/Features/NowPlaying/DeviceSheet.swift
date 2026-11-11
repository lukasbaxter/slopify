import SwiftUI

/// "Connect to a device" (UI.md 4.3, 4.4; DevicePicker.jsx:205-239). Present inside a bottom
/// sheet: `.bottomSheet(isPresented:) { DeviceSheet() }`. The sheet frame swallows taps, so
/// nothing reaches the page behind. No browser-only note (DECISIONS).
struct DeviceSheet: View {
    @Environment(Player.self) private var player
    @Environment(SessionClient.self) private var session
    @Environment(\.theme) private var theme
    @Environment(\.closeSheet) private var closeSheet

    var body: some View {
        let ps = NowPlayingSession(player: player, session: session)
        let devices = ps.devices
        let all = [NowPlayingDevice.local] + devices
        let active = ps.active
        let others = NowPlayingDevices.others(devices, active: active)
        VStack(alignment: .leading, spacing: 0) {
            // A. Header
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Connect to a device")).font(.system(size: 20, weight: .bold)).tracking(-0.3).foregroundStyle(theme.fg)
                if !devices.isEmpty {
                    Text(L("{n} on your network", ["n": devices.count])).font(.system(size: 13)).foregroundStyle(theme.fgSub)
                }
            }
            .padding(.top, 12).padding(.bottom, 16)

            // B. Current device
            HStack(spacing: 16) {
                IconView(NowPlayingDevices.icon(active), size: 32).foregroundStyle(theme.accentInk)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Current device")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                    Text(NowPlayingDevices.label(active, in: all)).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.accentInk).lineLimit(1)
                    Text(NowPlayingDevices.subline(active, in: all)).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                    QualityBadge(format: ps.deliveredFormat(player.current), small: true).padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 12).padding(.bottom, 16)
            .overlay(alignment: .bottom) { Rectangle().fill(theme.fg(0.1)).frame(height: 1) }
            .padding(.bottom, 8)
            .accessibilityElement(children: .combine)

            // C, D. Other devices
            if !others.isEmpty {
                Text(L("Select another device")).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
                    .padding(.top, 12).padding(.bottom, 4)
                ForEach(others) { d in
                    Button { pick(d) } label: {
                        HStack(spacing: 16) {
                            IconView(NowPlayingDevices.icon(d), size: 24).foregroundStyle(theme.fg)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(NowPlayingDevices.label(d, in: all)).font(.system(size: 16)).foregroundStyle(theme.fg).lineLimit(1)
                                Text(NowPlayingDevices.subline(d, in: all)).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 10)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.pressPlain)
                }
            }

            // F. Speaker volume (only while the session is not on this phone)
            if ps.casting {
                NowPlayingVolumeSlider()
                    .padding(.top, 12)
                    .overlay(alignment: .top) { Rectangle().fill(theme.fg(0.1)).frame(height: 1).padding(.horizontal, -16) }
                    .padding(.top, 8)
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `onSelect(d); close()`: the transfer starts at once, the sheet slides out.
    private func pick(_ d: NowPlayingDevice) {
        switch d.kind {
        case "local": player.transfer(toClient: nil)
        case "relay": player.transfer(toClient: d.relayClientId)
        default: if let lan = d.lan { player.transfer(toSpeaker: lan) }
        }
        closeSheet()
    }
}

/// `SheetVolume` (DevicePicker.jsx:64-124): 22 pt speaker glyphs either side of an 8 pt accent bar
/// with a 20 pt thumb. The finger x sets the value anywhere on the bar; sends are throttled to one
/// per 120 ms plus the final value, and the sent value is held 2 s against echoes.
struct NowPlayingVolumeSlider: View {
    @Environment(Player.self) private var player
    @Environment(\.theme) private var theme
    @State private var dragValue: Double?
    @State private var held: (value: Double, until: Date)?
    @State private var throttle = NowPlayingMath.Throttle(interval: 0.12)
    @State private var trailing: Task<Void, Never>?

    private var shown: Double {
        if let dragValue { return dragValue }
        if let h = held, h.until > Date() { return h.value }
        return player.volume
    }

    var body: some View {
        HStack(spacing: 14) {
            IconView(.volumeLow, size: 22)
            GeometryReader { g in
                let f = min(1, max(0, shown / 100))
                ZStack(alignment: .leading) {
                    Rectangle().fill(theme.fg(0.3)).frame(height: 8)
                    Rectangle().fill(theme.accent).frame(width: g.size.width * f, height: 8)
                    Circle().fill(theme.accent).frame(width: 20, height: 20)
                        .scaleEffect(dragValue != nil ? 1.25 : 1)
                        .animation(.easeOut(duration: 0.12), value: dragValue != nil)
                        .offset(x: g.size.width * f - 10)
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .local)
                    .onChanged { v in move(NowPlayingMath.volumeValue(x: v.location.x, width: g.size.width)) }
                    .onEnded { v in end(NowPlayingMath.volumeValue(x: v.location.x, width: g.size.width)) })
            }
            .frame(height: 44)
            IconView(.volumeHigh, size: 22)
        }
        .foregroundStyle(theme.fg)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Speaker volume"))
        .accessibilityValue(L("Volume {n}%", ["n": Int(shown)]))
        .accessibilityAdjustableAction { dir in
            let v = max(0, min(100, shown + (dir == .increment ? 5 : -5)))
            send(v)
        }
    }

    private func move(_ v: Double) {
        dragValue = v
        switch throttle.offer(v, now: Date().timeIntervalSince1970) {
        case .send(let x): send(x)
        case .wait(let delay):
            guard trailing == nil else { return }
            trailing = Task {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                trailing = nil
                guard !Task.isCancelled, let x = throttle.flush(now: Date().timeIntervalSince1970) else { return }
                send(x)
            }
        }
    }

    private func end(_ v: Double) {
        trailing?.cancel(); trailing = nil
        _ = throttle.flush(now: Date().timeIntervalSince1970)
        send(v)
        dragValue = nil
    }

    private func send(_ v: Double) {
        held = (v, Date().addingTimeInterval(2))
        player.setVolume(v)
    }
}
