import SwiftUI

/// The phone queue page (UI.md 3.3; RightPanel.jsx:43-262, 433-484). Uses the theme's own
/// tokens (no dark island). Reorder by the drag handle; remove from the long-press sheet.
struct QueueView: View {
    @Environment(AppModel.self) private var app
    @Environment(Player.self) private var player
    @Environment(SessionClient.self) private var session
    @Environment(Navigator.self) private var nav
    @Environment(Likes.self) private var likes
    @Environment(Account.self) private var account
    @Environment(\.theme) private var theme
    @Environment(\.apiClient) private var envApi

    @State private var from: NowPlayingFrom = .fallback
    @State private var menu: MenuSheet?
    // Drag to reorder: absolute queue index lifted, finger travel, target slot.
    @State private var dragFrom: Int?
    @State private var dragDY: CGFloat = 0
    @State private var dragTo: Int?

    private let rowHeight: CGFloat = 64
    private var api: APIClient { envApi ?? account.api }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 24) { sections }
                    .padding(.top, 8)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 80)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDisabled(dragFrom != nil)
            if player.current != nil { transport }
        }
        .background(theme.page.ignoresSafeArea())
        .contextMenuSheet($menu)
        .task(id: player.context) { from = NowPlayingFrom.immediate(player.context) ?? from; from = await NowPlayingFrom.resolve(player.context, api: api) }
    }

    // MARK: Header (.panel-header)

    private var header: some View {
        HStack(spacing: 0) {
            Button { close() } label: {
                IconView(.chevronDown, size: 24).foregroundStyle(theme.fg).frame(width: 44, height: 44)
            }
            .buttonStyle(.pressFade)
            .accessibilityLabel(L("Close panel"))
            VStack(spacing: 0) {
                Text(from.kind.uppercased()).font(.system(size: 11, weight: .medium)).tracking(0.88).foregroundStyle(theme.fg(0.7))
                Text(from.name).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.top, 4)
        .padding(.horizontal, 16)
        .frame(minHeight: 56)
    }

    /// The web unmounts now playing as the queue opens, so closing the queue lands on the page.
    private func close() {
        nav.queueOpen = false
        nav.nowPlayingOpen = false
    }

    // MARK: Sections

    @ViewBuilder
    private var sections: some View {
        let q = player.queue, idx = player.index
        if q.isEmpty {
            VStack(spacing: 8) {
                Text(L("Add to your queue")).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
                Text(L("Play an album or playlist, or use “Add to queue” on any song.")).font(.system(size: 13)).foregroundStyle(theme.fgSub)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
        } else {
            let base = idx + 1
            let split = queuedRun(from: base)
            if q.indices.contains(idx) {
                section(L("Now playing")) {
                    row(q[idx], pos: idx, current: true)
                }
            }
            if split > 0 {
                section(L("Next in queue"), action: (L("Clear queue"), { player.clearQueued() })) {
                    ForEach(base..<(base + split), id: \.self) { i in row(q[i], pos: i, current: false) }
                }
            }
            let ctxStart = base + split
            if ctxStart < q.count {
                section(player.context != nil ? L("Next from: {name}", ["name": from.name]) : L("Next up")) {
                    ForEach(ctxStart..<min(q.count, ctxStart + 80), id: \.self) { i in row(q[i], pos: i, current: false) }
                }
            }
            if split == 0 && ctxStart >= q.count {
                Text(L("End of the queue.")).font(.system(size: 13)).foregroundStyle(theme.fgSub).padding(.vertical, 12)
            }
        }
    }

    private func queuedRun(from base: Int) -> Int {
        let flags = player.queuedFlags
        var n = 0
        while base + n < flags.count, flags[base + n] { n += 1 }
        return n
    }

    private func section<C: View>(_ title: String, action: (String, () -> Void)? = nil, @ViewBuilder rows: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(title).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg).lineLimit(1)
                Spacer()
                if let action {
                    Button(action.0, action: action.1)
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                        .padding(.vertical, 8)
                        .buttonStyle(.pressFade)
                }
            }
            .frame(minHeight: 32)
            .padding(.bottom, 4)
            rows()
        }
    }

    // MARK: Row (.qrow)

    /// Smart-shuffle picks (`_rec`). Only the local queue knows them.
    private func isRec(_ pos: Int) -> Bool { player.recFlags.indices.contains(pos) && player.recFlags[pos] }

    private func row(_ t: Track, pos: Int, current: Bool) -> some View {
        let lifted = dragFrom == pos
        let shift: CGFloat = {
            guard let f = dragFrom, let to = dragTo, !lifted else { return 0 }
            return NowPlayingMath.reorderShift(row: pos, from: f, to: to, rowHeight: rowHeight)
        }()
        return HStack(spacing: 12) {
            Button { player.skip(to: pos) } label: {
                CoverImage(NowPlayingCover.source(t), size: 48, shape: .rounded(Radius.art), placeholder: .cardHover)
                    .frame(width: 48, height: 48)
            }
            .buttonStyle(.pressPlain)
            .accessibilityLabel(L("Play"))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if isRec(pos) { IconView(.smartPick, size: 12).foregroundStyle(theme.accentInk) }
                    Text(t.title).font(.system(size: 16)).foregroundStyle(current ? theme.accentInk : theme.fg).lineLimit(1)
                }
                .contentShape(Rectangle())
                .onTapGesture { if !t.albumId.isEmpty { nav.open(.album(id: t.albumId)) } }
                NowPlayingArtistLinks(track: t) { id in nav.open(.artist(id: id)) }
                    .font(.system(size: 13)).foregroundStyle(theme.fgSub)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if !current {
                IconView(.handle, size: 24).foregroundStyle(theme.fgSub)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
                    .padding(.trailing, -12)
                    .gesture(reorderGesture(pos))
                    .accessibilityLabel(L("Drag to reorder"))
            }
        }
        .frame(minHeight: rowHeight)
        .padding(.horizontal, lifted ? 8 : 0)
        .background {
            if lifted {
                RoundedRectangle(cornerRadius: Radius.row).fill(theme.sheet)
                    .shadow(color: .black.opacity(0.5), radius: 12, y: 8)
            }
        }
        .padding(.horizontal, lifted ? -8 : 0)
        .offset(y: lifted ? dragDY : shift)
        .animation(lifted ? nil : .easeOut(duration: 0.15), value: shift)
        .zIndex(lifted ? 3 : 0)
        .pressable(.row, onLongPress: dragFrom == nil ? { openMenu(t, pos: pos, current: current) } : nil)
    }

    private func reorderGesture(_ pos: Int) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { v in
                if dragFrom == nil { dragFrom = pos; dragTo = pos }
                dragDY = v.translation.height
                dragTo = NowPlayingMath.reorderTarget(from: pos, dy: v.translation.height, rowHeight: rowHeight,
                                                     current: player.index, count: player.queue.count)
            }
            .onEnded { _ in
                if let f = dragFrom, let to = dragTo, f != to { player.moveInQueue(from: f, to: to) }
                var t = Transaction(); t.disablesAnimations = true
                withTransaction(t) { dragFrom = nil; dragTo = nil; dragDY = 0 }
            }
    }

    private func openMenu(_ t: Track, pos: Int, current: Bool) {
        let menus = NowPlayingMenus(menus: TrackMenuBuilder(app: app) { _ in })
        menu = menus.queueRow(t, at: pos, removable: !current)
    }

    // MARK: Pinned transport (.panel-transport)

    private var transport: some View {
        HStack(spacing: 0) {
            Button { player.setShuffle(player.shuffle.nowPlayingNext) } label: {
                ShuffleGlyph(mode: player.shuffle.nowPlayingGlyph, size: 24)
                    .foregroundStyle(player.shuffle == .off ? theme.fg : theme.accentInk).frame(width: 44, height: 44)
            }
            .padding(.leading, -6)
            .accessibilityLabel(L("Shuffle"))
            Spacer(minLength: 0)
            Button { player.previous() } label: { IconView(.previous, size: 32).foregroundStyle(theme.fg).frame(width: 44, height: 44) }
                .accessibilityLabel(L("Previous"))
            Spacer(minLength: 0)
            Button { player.togglePlay() } label: {
                IconView(player.isPlaying ? .pause : .play, size: 22).foregroundStyle(theme.onFg)
                    .frame(width: 48, height: 48).background(theme.fg, in: Circle())
            }
            .accessibilityLabel(player.isPlaying ? L("Pause") : L("Play"))
            Spacer(minLength: 0)
            Button { player.next() } label: { IconView(.next, size: 32).foregroundStyle(theme.fg).frame(width: 44, height: 44) }
                .accessibilityLabel(L("Next"))
            Spacer(minLength: 0)
            Button { player.setRepeat(player.repeatMode.nowPlayingNext) } label: {
                RepeatGlyph(mode: player.repeatMode.nowPlayingGlyph, size: 24)
                    .foregroundStyle(player.repeatMode == .off ? theme.fg : theme.accentInk).frame(width: 44, height: 44)
            }
            .padding(.trailing, -6)
            .accessibilityLabel(L("Repeat"))
        }
        .buttonStyle(.pressFade)
        .frame(height: 64)
        .padding(.horizontal, 24)
        .background(theme.page.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            ZStack(alignment: .top) {
                Rectangle().fill(theme.fg(0.06)).frame(height: 1)
                // The native app uses the live playhead (UI.md 3.3.5 asks), not the coarse position.
                TimelineView(.periodic(from: .now, by: player.isPlaying ? 0.25 : 3600)) { _ in
                    let f = NowPlayingMath.fraction(player.isPlaying ? player.positionNow() : player.position, duration: player.duration)
                    GeometryReader { g in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(theme.fg(0.2))
                            Rectangle().fill(theme.fg).frame(width: g.size.width * f)
                        }
                    }
                    .frame(height: 2)
                    .id(player.progressTick)
                }
                .offset(y: -2)
                .padding(.horizontal, -24)
            }
            .allowsHitTesting(false)
        }
    }
}
