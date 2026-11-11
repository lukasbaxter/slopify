import SwiftUI

/// Full-screen now playing (UI.md 3.2, 4.2.2, 4.5.4; FullScreen.jsx, mobile-nowplaying.css:5-111).
/// Always opens on the Album tab; swipe down or the chevron closes it.
struct NowPlayingView: View {
    @Environment(AppModel.self) private var app
    @Environment(Player.self) private var player
    @Environment(SessionClient.self) private var session
    @Environment(Navigator.self) private var nav
    @Environment(Likes.self) private var likes
    @Environment(Account.self) private var account
    @Environment(\.theme) private var theme
    @Environment(\.apiClient) private var envApi
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum Tab { case album, lyrics }
    @State private var tab: Tab = .album
    @State private var npColor: RGB?
    @State private var from: NowPlayingFrom = .fallback
    // Swipe down to close.
    @State private var drag: CGFloat = 0
    @State private var dragStart: Date?
    @State private var dragging = false
    @State private var lyricsAtTop = true
    // Scrub.
    @State private var scrub: Double?
    @State private var scrubbing = false
    @State private var scrubRelease: Task<Void, Never>?
    // Sheets.
    @State private var menu: MenuSheet?
    @State private var showDevices = false
    @State private var dialog: NameDialog?
    @State private var sleepOverride: SleepOverride?

    private var api: APIClient { envApi ?? account.api }
    private var ps: NowPlayingSession { NowPlayingSession(player: player, session: session) }

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .top) {
                background(g)
                VStack(spacing: 0) {
                    topRow
                    if tab == .album {
                        stage
                        bottomBlock
                    } else {
                        NowPlayingLyricsPane(track: player.current, atTop: $lyricsAtTop)
                            .frame(maxHeight: .infinity)
                    }
                }
            }
            .offset(y: drag)
            .simultaneousGesture(dismissGesture(height: g.size.height + g.safeAreaInsets.top + g.safeAreaInsets.bottom))
        }
        .darkIsland()
        .presentationBackground(.clear)
        .contextMenuSheet($menu)
        .nameDialog($dialog)
        .bottomSheet(isPresented: $showDevices) { DeviceSheet() }
        .task(id: player.context) { from = NowPlayingFrom.immediate(player.context) ?? from; from = await NowPlayingFrom.resolve(player.context, api: api) }
        .task(id: colorURL) { let c = await ArtworkColor.shared.vibrant(colorURL); withAnimation(.linear(duration: 0.3)) { npColor = c } }
        .onAppear { ToastCenter.shared.layout = .nowPlaying }
        .onDisappear { ToastCenter.shared.layout = .shell(miniPlayer: true) }
    }

    // MARK: Background

    @ViewBuilder
    private func background(_ g: GeometryProxy) -> some View {
        if tab == .album {
            let np = npColor ?? Theme.Fixed.nowPlayingFallback
            LinearGradient(stops: [.init(color: np.color, location: 0),
                                   .init(color: np.colorMix(0.55, theme.rgb.page).color, location: 0.45),
                                   .init(color: theme.page, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        } else {
            ZStack {
                theme.page
                if let t = player.current {
                    CoverImage(NowPlayingCover.source(t), size: 320, shape: .rounded(0), placeholder: .none)
                        .scaleEffect(1.1)
                        .blur(radius: 60)
                        .brightness(-0.68)
                        .saturation(1.3)
                        .padding(-60)
                        .id(t.id)
                        .transition(.opacity.animation(reduceMotion ? nil : .easeInOut(duration: 0.9)))
                }
            }
            .clipped()
            .ignoresSafeArea()
        }
    }

    private var colorURL: URL? { player.current.map { NowPlayingCover.source($0).url(api, size: 320) } ?? nil }

    // MARK: Top row (.fs-top)

    private var topRow: some View {
        HStack(spacing: 0) {
            Button {
                if tab == .lyrics { tab = .album } else { close() }
            } label: {
                IconView(.chevronDown, size: 24).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .buttonStyle(.pressFade)
            .accessibilityLabel(L("Close"))
            VStack(spacing: 0) {
                if tab == .album {
                    Text(from.kind.uppercased())
                        .font(.system(size: 11, weight: .medium)).tracking(0.88)
                        .foregroundStyle(theme.fg(0.7))
                    Text(from.name).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                } else {
                    Text(player.current?.title ?? "").font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                    Text(player.current?.creditLine ?? "").font(.system(size: 13)).foregroundStyle(theme.fgSub)
                }
            }
            .lineLimit(1)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
            Button { openMenu() } label: {
                IconView(.dots24, size: 24).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .buttonStyle(.pressFade)
            .disabled(player.current == nil)
            .opacity(player.current == nil ? 0.35 : 1)
            .accessibilityLabel(L("More"))
        }
        .padding(.top, 4)
        .padding(.horizontal, 16)
        .frame(minHeight: 56)
    }

    // MARK: Stage (.fs-stage)

    private var stage: some View {
        GeometryReader { g in
            let side = max(0, min(g.size.width - 48, g.size.height - 24))
            SteadyArt(track: player.current, api: api)
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: Radius.panel))
                .padding(.top, 24)
                .frame(maxWidth: .infinity, alignment: .top)
        }
        .frame(maxHeight: .infinity)
    }

    // MARK: Bottom block (.fs-bottom)

    private var bottomBlock: some View {
        VStack(spacing: 0) {
            meta.padding(.bottom, 16)
            seek.padding(.top, -20).padding(.bottom, 8)
            controls.padding(.bottom, 24)
            phoneRow
        }
        .padding(.top, 24)
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
    }

    private var meta: some View {
        let t = player.current
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Marquee(t?.title ?? L("Nothing playing"))
                    .font(.system(size: 24, weight: .bold)).tracking(-0.3)
                    .foregroundStyle(theme.fg)
                if let t {
                    NowPlayingArtistLinks(track: t) { id in nav.open(.artist(id: id)) }
                        .font(.system(size: 16)).foregroundStyle(theme.fgSub)
                        .padding(.top, 2)
                    QualityBadge(format: ps.deliveredFormat(t)).padding(.top, 6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let t {
                let liked = likes.isLiked(t.id)
                Button { Task { await NowPlayingLike.toggle(t.id, likes: likes) } } label: {
                    IconView(.heart, filled: liked, size: 24).foregroundStyle(theme.fg).frame(width: 44, height: 44)
                }
                .buttonStyle(.pressFade)
                .padding(.trailing, -10)
                .accessibilityLabel(liked ? L("Remove from Liked Songs") : L("Save to Liked Songs"))
            }
        }
    }

    // MARK: Seek bar (.fs-seek)

    private var seek: some View {
        TimelineView(.periodic(from: .now, by: player.isPlaying && scrub == nil ? 0.25 : 3600)) { _ in
            let duration = player.duration
            let shown = scrub ?? min(player.isPlaying ? player.positionNow() : player.position, duration)
            let f = NowPlayingMath.fraction(shown, duration: max(1, duration))
            VStack(spacing: 0) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(theme.fg(0.3)).frame(height: 4)
                        Rectangle().fill(theme.fg).frame(width: g.size.width * f, height: 4)
                        Circle().fill(theme.fg).frame(width: 12, height: 12)
                            .scaleEffect(scrubbing ? 1.34 : 1)
                            .animation(.easeOut(duration: 0.12), value: scrubbing)
                            .offset(x: g.size.width * f - 6)
                    }
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(scrubGesture(width: g.size.width, duration: duration))
                }
                .frame(height: 44)
                .padding(.bottom, -14)
                HStack {
                    Text(NowPlayingMath.time(shown))
                    Spacer()
                    Text(NowPlayingMath.remaining(shown, duration: duration))
                }
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(theme.fgSub)
            }
            .id(player.progressTick)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Seek"))
        .accessibilityValue(NowPlayingMath.time(player.position))
        .accessibilityAdjustableAction { dir in
            let step: Double = dir == .increment ? 15 : -15
            player.seek(to: max(0, min(player.duration, player.positionNow() + step)))
        }
    }

    private func scrubGesture(width: CGFloat, duration: Double) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { v in
                if !scrubbing {
                    scrubbing = true
                    scrubRelease?.cancel()
                }
                scrub = NowPlayingMath.scrubValue(x: v.location.x, width: width, duration: duration)
            }
            .onEnded { v in
                let value = NowPlayingMath.scrubValue(x: v.location.x, width: width, duration: duration)
                scrub = value
                scrubbing = false
                player.seek(to: value)
                let hold = NowPlayingMath.scrubHold(mirroring: ps.mirroring)
                scrubRelease?.cancel()
                scrubRelease = Task {
                    try? await Task.sleep(nanoseconds: UInt64(hold * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    scrub = nil
                }
            }
    }

    // MARK: Transport (.fs-controls)

    private var controls: some View {
        HStack(spacing: 0) {
            Button { player.setShuffle(player.shuffle.nowPlayingNext) } label: {
                ShuffleGlyph(mode: player.shuffle.nowPlayingGlyph, size: 24)
                    .foregroundStyle(player.shuffle == .off ? theme.fg : theme.accentInk)
                    .frame(width: 44, height: 44)
            }
            .padding(.leading, -6)
            .accessibilityLabel(L("Shuffle"))
            Spacer(minLength: 0)
            Button { player.previous() } label: {
                IconView(.previous, size: 32).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .accessibilityLabel(L("Previous"))
            Spacer(minLength: 0)
            Button { player.togglePlay() } label: {
                IconView(player.isPlaying ? .pause : .play, size: 28)
                    .foregroundStyle(theme.onFg)
                    .frame(width: 64, height: 64)
                    .background(theme.fg, in: Circle())
            }
            .accessibilityLabel(player.isPlaying ? L("Pause") : L("Play"))
            Spacer(minLength: 0)
            Button { player.next() } label: {
                IconView(.next, size: 32).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .accessibilityLabel(L("Next"))
            Spacer(minLength: 0)
            Button { player.setRepeat(player.repeatMode.nowPlayingNext) } label: {
                RepeatGlyph(mode: player.repeatMode.nowPlayingGlyph, size: 24)
                    .foregroundStyle(player.repeatMode == .off ? theme.fg : theme.accentInk)
                    .frame(width: 44, height: 44)
            }
            .padding(.trailing, -6)
            .accessibilityLabel(L("Repeat"))
        }
        .buttonStyle(.pressFade)
    }

    // MARK: Bottom row (.fs-phone-row)

    private var phoneRow: some View {
        let ps = ps
        return HStack(spacing: 0) {
            NowPlayingDeviceButton(casting: ps.casting, label: NowPlayingDevices.label(ps.active, in: ps.devices), showName: true) { showDevices = true }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, -10)
            Button { tab = .lyrics } label: {
                IconView(.lyrics24, size: 24).foregroundStyle(tab == .lyrics ? theme.accentInk : theme.fg).frame(width: 44, height: 44)
            }
            .accessibilityLabel(L("Lyrics"))
            Button { nav.queueOpen = true } label: {
                IconView(.queue24, size: 24).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .padding(.trailing, -10)
            .accessibilityLabel(L("Queue"))
        }
        .buttonStyle(.pressFade)
    }

    // MARK: Closing

    private func close() { nav.nowPlayingOpen = false }

    private func dismissGesture(height: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .onChanged { v in
                guard !scrubbing, menu == nil, !showDevices else { return }
                if tab == .lyrics && !lyricsAtTop && !dragging { return }
                let dy = v.translation.height, dx = v.translation.width
                if !dragging {
                    guard dy > 0, abs(dx) < dy else { return }
                    dragging = true
                    dragStart = Date()
                }
                drag = max(0, dy)
            }
            .onEnded { v in
                guard dragging else { return }
                dragging = false
                let elapsed = Date().timeIntervalSince(dragStart ?? Date())
                dragStart = nil
                if NowPlayingMath.dismissesNowPlaying(dy: v.translation.height, elapsed: elapsed) {
                    withAnimation(.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.25)) { drag = height }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                        var t = Transaction(); t.disablesAnimations = true
                        withTransaction(t) { nav.nowPlayingOpen = false }
                    }
                } else {
                    withAnimation(.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.25)) { drag = 0 }
                }
            }
    }

    // MARK: Menu

    private struct SleepOverride { var value: (at: Double?, endOfTrack: Bool)?; var until: Date }

    private var sleepState: (at: Double?, endOfTrack: Bool)? {
        if let o = sleepOverride, o.until > Date() { return o.value }
        return session.sleep
    }

    private func openMenu() {
        guard let t = player.current else { return }
        let menus = NowPlayingMenus(menus: TrackMenuBuilder(app: app) { dialog = $0 }, sleep: sleepState,
                                    setSleep: { pick in setSleep(pick) })
        menu = menus.nowPlaying(t)
    }

    private func setSleep(_ pick: NowPlayingMenus.SleepPick) {
        // Optimistic: shown at once, the server's broadcast confirms it.
        let now = Date().timeIntervalSince1970 * 1000
        switch pick {
        case .minutes(let m):
            sleepOverride = SleepOverride(value: (at: now + Double(m) * 60000, endOfTrack: false), until: Date().addingTimeInterval(3))
            session.setSleep(minutes: m)
        case .endOfTrack:
            sleepOverride = SleepOverride(value: (at: nil, endOfTrack: true), until: Date().addingTimeInterval(3))
            session.setSleepEndOfTrack()
        case .off:
            sleepOverride = SleepOverride(value: nil, until: Date().addingTimeInterval(3))
            session.setSleep(minutes: nil)
        }
    }
}

/// The big cover (`useSteadyArt`, FullScreen.jsx:66-102): keeps the previous song's art until the
/// new one has loaded, paints the 320 copy then swaps in the 640 one, and fades each new song in
/// (`fs-art-in .45s`: opacity .4 -> 1, scale .985 -> 1).
private struct SteadyArt: View {
    let track: Track?
    let api: APIClient
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var image: UIImage?
    @State private var shownId: String?
    @State private var fadeIn = true

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                theme.fg(0.08)
            }
        }
        .opacity(fadeIn ? 1 : 0.4)
        .scaleEffect(fadeIn ? 1 : 0.985)
        .task(id: track?.id) { await load() }
        .accessibilityHidden(true)
    }

    private func load() async {
        guard let track else { image = nil; shownId = nil; return }
        let src = NowPlayingCover.source(track)
        let lo = src.url(api, size: 320), hi = src.url(api, size: 640)
        var first = true
        for u in [lo, hi].compactMap({ $0 }) {
            let img: UIImage?
            if let c = ImageLoader.shared.cached(u) { img = c } else { img = await ImageLoader.shared.image(u) }
            guard !Task.isCancelled else { return }
            guard let img else { continue }
            if first && shownId != track.id {
                // A new song: run the fade once; the hi swap does not re-run it.
                image = img
                shownId = track.id
                if !reduceMotion {
                    fadeIn = false
                    withAnimation(.easeOut(duration: 0.45)) { fadeIn = true }
                }
            } else {
                image = img
            }
            first = false
        }
        if shownId != track.id { image = nil; shownId = track.id }
    }
}
