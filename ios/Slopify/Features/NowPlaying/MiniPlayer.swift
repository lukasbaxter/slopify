import SwiftUI

/// The floating mini player card (UI.md 3.1, 4.2.1, 4.5.3; Player.jsx:190-444,
/// mobile-nowplaying.css:125-164). Tap opens now playing; swipe left/right skips.
struct MiniPlayer: View {
    @Environment(Player.self) private var player
    @Environment(SessionClient.self) private var session
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme
    @Environment(\.apiClient) private var api

    @State private var tint: RGB?
    @State private var showDevices = false
    /// The error text the user tapped away (Player has no clearError yet).
    // Swipe to skip: only the art + text follow the finger.
    @State private var dx: CGFloat = 0
    @State private var nowOpacity: Double = 1
    @State private var dragStart: Date?
    @State private var abandoned = false
    @State private var nowWidth: CGFloat = 320

    var body: some View {
        VStack(spacing: 0) {
            if let e = player.error { errorBar(e) }
            card.darkIsland()
                .padding(.bottom, Shell.miniPlayerGap)
        }
        .padding(.top, Shell.miniPlayerFade)
        .padding(.horizontal, 8)
        .background(
            LinearGradient(stops: [.init(color: theme.page(0), location: 0),
                                   .init(color: theme.page(0.92), location: 0.27),
                                   .init(color: theme.page, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)
        )
        .bottomSheet(isPresented: $showDevices) { DeviceSheet() }
    }

    // MARK: Card

    private var card: some View {
        let track = player.current
        let ps = NowPlayingSession(player: player, session: session)
        return HStack(spacing: 0) {
            now(track, elsewhere: ps.elsewhere)
                .offset(x: dx)
                .opacity(nowOpacity)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(GeometryReader { g in
                    Color.clear.onAppear { nowWidth = g.size.width }.onChange(of: g.size.width) { _, w in nowWidth = w }
                })
            NowPlayingDeviceButton(casting: ps.casting, label: NowPlayingDevices.nameFor(ps.active)) { showDevices = true }
            Button { player.togglePlay() } label: {
                IconView(player.isPlaying ? .pause : .play, size: 20)
                    .foregroundStyle(theme.fg)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.pressPlain)
            .disabled(track == nil)
            .opacity(track == nil ? 0.3 : 1)
            .padding(.trailing, -8)
            .accessibilityLabel(player.isPlaying ? L("Pause") : L("Play"))
        }
        .padding(.horizontal, 8)
        .frame(height: Shell.miniPlayer)
        .background((tint ?? theme.rgb.chip).colorMix(0.55, .black).color)
        .animation(.linear(duration: 0.3), value: tint)
        .overlay(alignment: .bottom) { progressLine.padding(.horizontal, 8) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.row))
        .contentShape(RoundedRectangle(cornerRadius: Radius.row))
        .onTapGesture { nav.nowPlayingOpen = true }
        .simultaneousGesture(skipGesture)
        .task(id: tintURL) { tint = await ArtworkColor.shared.mini(tintURL) }
    }

    private var tintURL: URL? { player.current.map { NowPlayingCover.source($0).url(api, size: 128) } ?? nil }

    private func now(_ track: Track?, elsewhere: String?) -> some View {
        HStack(spacing: 8) {
            Group {
                if let track {
                    CoverImage(NowPlayingCover.source(track), size: 40, shape: .rounded(Radius.art), placeholder: .cardHover)
                } else {
                    RoundedRectangle(cornerRadius: Radius.art).fill(theme.cardHover)
                }
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(track?.title ?? L("Nothing playing"))
                    .textStyle(.miniTitle).foregroundStyle(theme.fg).lineLimit(1)
                if let elsewhere {
                    HStack(spacing: 6) {
                        IconView(.cast, size: 13)
                        Marquee(L("Playing on {name}", ["name": elsewhere])).textStyle(.miniArtist)
                    }
                    .foregroundStyle(theme.accentInk)
                } else if let track {
                    Text(track.creditLine).textStyle(.miniArtist).foregroundStyle(theme.fg(0.7)).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// 2 pt line, `--fg` over `rgba(fg,.25)`, read from the live playhead every 250 ms.
    private var progressLine: some View {
        TimelineView(.periodic(from: .now, by: player.isPlaying ? 0.25 : 3600)) { _ in
            let f = NowPlayingMath.fraction(player.isPlaying ? player.positionNow() : player.position, duration: player.duration)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Rectangle().fill(theme.fg(0.25))
                    Rectangle().fill(theme.fg).frame(width: g.size.width * f)
                }
            }
            .frame(height: 2)
            .clipShape(RoundedRectangle(cornerRadius: 1))
            .id(player.progressTick)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func errorBar(_ e: String) -> some View {
        Text(e)
            .font(.system(size: 14)).foregroundStyle(theme.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8).padding(.horizontal, 16)
            .background(theme.dangerBg, in: RoundedRectangle(cornerRadius: 4))
            .padding(.bottom, 8)
            .onTapGesture { player.clearError() }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(L("Dismiss"))
    }

    // MARK: Swipe to skip (App.jsx:1434-1450, Player.jsx:223-245)

    private var skipGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .local)
            .onChanged { v in
                let x = v.translation.width, y = v.translation.height
                if dragStart == nil {
                    dragStart = Date()
                    abandoned = NowPlayingMath.abandonsSwipe(dx: x, dy: y)
                }
                guard !abandoned else { return }
                let f = NowPlayingMath.skipFollow(dx: x)
                dx = f.offset; nowOpacity = f.opacity
            }
            .onEnded { v in
                let elapsed = Date().timeIntervalSince(dragStart ?? Date())
                dragStart = nil
                let wasAbandoned = abandoned
                abandoned = false
                if player.current != nil,
                   let s = NowPlayingMath.skip(dx: v.translation.width, dy: v.translation.height, elapsed: elapsed) {
                    runSkip(s)
                } else if !wasAbandoned || dx != 0 {
                    withAnimation(.easeOut(duration: 0.18)) { dx = 0; nowOpacity = 1 }
                }
            }
    }

    private func runSkip(_ s: NowPlayingMath.Skip) {
        if s == .next { player.next() } else { player.previous() }
        let out = (s == .next ? -1.2 : 1.2) * nowWidth
        withAnimation(.easeOut(duration: 0.18)) { dx = out; nowOpacity = 0 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { dx = s == .next ? 40 : -40 }
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.2)) { dx = 0; nowOpacity = 1 }
            }
        }
    }
}

/// `.devicebtn` (DevicePicker.jsx:196-201): the Connect glyph, green while casting. With
/// `showName` (now playing) the name follows the glyph while casting.
struct NowPlayingDeviceButton: View {
    var casting: Bool
    var label: String
    var showName = false
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                IconView(.connect, size: 24)
                if showName && casting {
                    Marquee(label).font(.system(size: 12, weight: .semibold))
                }
            }
            .foregroundStyle(casting ? theme.accentInk : theme.fg)
            .padding(.horizontal, showName ? 10 : 0)
            .frame(minWidth: 44, minHeight: 44, maxHeight: 44, alignment: showName ? .leading : .center)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
        .accessibilityLabel(L("Playing on {name}", ["name": label]))
    }
}
