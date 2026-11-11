import SwiftUI

/// The now playing Lyrics tab body (RightPanel.jsx `Lyrics`; UI.md 3.2.5, 3.4).
struct NowPlayingLyricsPane: View {
    let track: Track?
    /// True while the pane is scrolled to the top (swipe-down may close now playing).
    @Binding var atTop: Bool

    @Environment(Player.self) private var player
    @Environment(SessionClient.self) private var session
    @Environment(\.theme) private var theme
    @Environment(\.apiClient) private var api

    enum LoadState: Equatable { case idle, loading, none, ok }
    @State private var state: LoadState = .idle
    @State private var lines: [NowPlayingLyricLine] = []
    @State private var activeIndex = -1
    @State private var manual = false

    private var jobs: LyricJobStore { LyricJobStore.shared }
    private var revision: Int { track.map { jobs.revision[$0.id] ?? 0 } ?? 0 }
    private var loadKey: String { "\(track?.id ?? "")#\(revision)" }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    GeometryReader { g in
                        Color.clear.preference(key: TopOffsetKey.self, value: g.frame(in: .named("lyrics")).minY)
                    }
                    .frame(height: 0)
                    content(proxy)
                }
                .padding(.top, 16)
                .padding(.horizontal, 24)
                .padding(.bottom, 48)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .coordinateSpace(name: "lyrics")
            .scrollIndicators(.hidden)
            .onPreferenceChange(TopOffsetKey.self) { y in atTop = y >= -1 }
            .simultaneousGesture(DragGesture(minimumDistance: 4).onChanged { _ in if state == .ok { manual = true } })
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.06),
                                         .init(color: .black, location: 0.92), .init(color: .clear, location: 1)],
                                 startPoint: .top, endPoint: .bottom))
            .overlay(alignment: .bottom) {
                if manual && state == .ok && NowPlayingLyrics.isSynced(lines) {
                    Button {
                        manual = false
                        withAnimation { proxy.scrollTo(activeIndex, anchor: .center) }
                    } label: {
                        Text(L("Sync")).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.onFg)
                            .padding(.vertical, 10).padding(.horizontal, 24)
                            .background(theme.fg, in: Capsule())
                    }
                    .buttonStyle(.pressFade)
                    .padding(.bottom, 16)
                    .transition(.opacity.combined(with: .offset(y: 6)))
                }
            }
            .animation(.easeOut(duration: 0.2), value: manual)
            .onChange(of: activeIndex) { _, i in
                guard !manual, i >= 0 else { return }
                withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(i, anchor: .center) }
            }
        }
        .task(id: loadKey) { await load() }
        .task(id: "\(loadKey)-tick") { await follow() }
        .onChange(of: track?.id) { _, _ in manual = false }
    }

    @ViewBuilder
    private func content(_ proxy: ScrollViewProxy) -> some View {
        let job = jobs.job(track?.id)
        switch state {
        case .loading:
            note(L("Loading lyrics..."))
        case .idle:
            note(L("Play something to see lyrics."))
        case .none:
            if let job { SyncBanner(job: job) }
            else if Connectivity.shared.offline { note(L("Lyrics aren’t available offline for this song.")) }
            else {
                VStack(alignment: .leading, spacing: 12) {
                    note(L("Looks like we don’t have the lyrics for this song."))
                    pill(L("Find and sync lyrics"), size: 14, v: 8, h: 16) { askSync() }
                }
            }
        case .ok:
            let synced = NowPlayingLyrics.isSynced(lines)
            VStack(alignment: .leading, spacing: 22) {
                if let job { SyncBanner(job: job).padding(.bottom, 14 - 22) }
                if !synced && job == nil {
                    HStack(spacing: 12) {
                        Text(L("These lyrics aren’t synced to the song yet.")).font(.system(size: 13)).foregroundStyle(theme.fgSub)
                            .fixedSize(horizontal: false, vertical: true)
                        pill(L("Sync them"), size: 13, v: 4, h: 12) { askSync() }
                    }
                    .padding(.bottom, 12 - 22)
                }
                ForEach(Array(lines.enumerated()), id: \.offset) { i, l in
                    Text(l.text)
                        .font(.system(size: 24, weight: .bold))
                        .tracking(l.gap ? 2.4 : -0.2)
                        .lineSpacing(24 * 0.3 - 4)
                        .foregroundStyle(!synced || i <= activeIndex ? theme.fg : theme.fg(0.5))
                        .animation(.easeOut(duration: 0.1), value: activeIndex)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            guard let s = l.start else { return }
                            player.seek(to: s)
                            manual = false
                            withAnimation { proxy.scrollTo(i, anchor: .center) }
                        }
                        .id(i)
                        .accessibilityAddTraits(l.start != nil ? .isButton : [])
                }
            }
            .padding(.bottom, 32)
        }
    }

    private func note(_ s: String) -> some View {
        Text(s).font(.system(size: 16)).foregroundStyle(theme.fgSub).padding(.vertical, 8)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func pill(_ title: String, size: CGFloat, v: CGFloat, h: CGFloat, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: size, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.vertical, v).padding(.horizontal, h)
                .overlay(Capsule().strokeBorder(theme.fg(0.3), lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
    }

    private func askSync() {
        guard let track, let api else { return }
        Task { await LyricJobStore.shared.sync(trackId: track.id, title: track.title, api: api) }
    }

    /// Fetch with 2/4/8 s retries; a 404 is "none" at once.
    private func load() async {
        guard let id = track?.id, let api else { state = .idle; lines = []; return }
        state = .loading
        var attempt = 0
        while !Task.isCancelled {
            do {
                let l = try await api.lyrics(id)
                guard !Task.isCancelled else { return }
                lines = l.map { NowPlayingLyrics.phoneLines(NowPlayingLyrics.lines($0)) } ?? []
                state = lines.isEmpty ? .none : .ok
                activeIndex = pick()
                return
            } catch {
                guard let d = NowPlayingLyrics.retryDelay(attempt: attempt) else { state = .none; return }
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(d * 1_000_000_000))
            }
        }
    }

    /// The active line from the live playhead, ten times a second.
    private func follow() async {
        while !Task.isCancelled {
            let i = pick()
            if i != activeIndex { activeIndex = i }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func pick() -> Int {
        guard state == .ok else { return -1 }
        // What is heard, not what the engine has played (RightPanel.jsx:346).
        let at = NowPlayingLyrics.lookupTime(playhead: player.positionNow() - player.outputLag(), speakerDelay: NowPlayingSession(player: player, session: session).speakerDelay)
        return NowPlayingLyrics.activeIndex(lines, at: at)
    }
}

private struct TopOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// `.lyrics-syncing`: spinner, **Syncing these lyrics** · {label}.
private struct SyncBanner: View {
    let job: LyricJob
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            Spinner()
            (Text(L("Syncing these lyrics")).bold().foregroundStyle(theme.fg) + Text(verbatim: " · " + LyricJobStore.label(job)))
                .font(.system(size: 14)).foregroundStyle(theme.fgDim)
        }
    }
}

/// 14 pt ring, 2 pt `rgba(fg,.2)` with an `--accent` top segment, one turn per 0.8 s.
private struct Spinner: View {
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = false

    var body: some View {
        ZStack {
            Circle().stroke(theme.fg(0.2), lineWidth: 2)
            Circle().trim(from: 0, to: 0.25).stroke(theme.accent, lineWidth: 2)
                .rotationEffect(.degrees(spin ? 360 : 0))
        }
        .frame(width: 14, height: 14)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) { spin = true }
        }
    }
}
