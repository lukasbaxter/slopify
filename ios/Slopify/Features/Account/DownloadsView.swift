import SwiftUI

/// State of the Downloads page: one scope at a time, the last answer per scope kept and shown at
/// once, a slow answer never stacked behind the next poll, and answers for a scope you left dropped.
@MainActor @Observable
final class AccountDownloadsModel {
    let source: AccountDownloadsSource
    private(set) var scope: DownloadScope = .mine
    private(set) var data: DownloadsPage?
    private(set) var error: String?
    private(set) var retrying: Int?
    @ObservationIgnored private var busy = false
    @ObservationIgnored private var generation = 0

    /// Last answer per scope for this run of the app (web keeps it in localStorage).
    private static var kept: [DownloadScope: DownloadsPage] = [:]

    init(source: AccountDownloadsSource) {
        self.source = source
        data = Self.kept[.mine]
    }

    func setScope(_ s: DownloadScope) {
        guard s != scope else { return }
        scope = s
        generation += 1
        busy = false
        data = Self.kept[s]
        error = nil
    }

    func load() async {
        guard !busy else { return }
        busy = true
        let gen = generation, s = scope
        defer { if gen == generation { busy = false } }
        do {
            let r = try await source.downloads(scope: s)
            guard gen == generation else { return }
            data = r; error = nil
            Self.kept[s] = r
        } catch is CancellationError {
        } catch {
            guard gen == generation else { return }
            self.error = AccountDownloadsLogic.cleanError(error.localizedDescription)
        }
    }

    /// Returns the toast to show.
    func retry(_ d: DownloadsPage.Item) async -> String {
        retrying = d.id
        defer { retrying = nil }
        do {
            try await source.retry(id: d.id)
            let msg = L("{title} is back in line", ["title": d.title])
            busy = false
            await load()
            return msg
        } catch {
            return L("Could not retry: {error}", ["error": AccountDownloadsLogic.cleanError(error.localizedDescription)])
        }
    }

    static func resetKept() { kept = [:] }
}

/// Drawer › Downloads (UI.md 5.9; web components/Downloads.jsx): albums requested through Slopify
/// and where each one is. Polls every 5 s while open and the app is active.
struct DownloadsView: View {
    var source: AccountDownloadsSource? = nil

    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(Player.self) private var player
    @Environment(\.theme) private var theme
    @Environment(\.scenePhase) private var phase
    @State private var model: AccountDownloadsModel?

    var body: some View {
        DetailScaffold(title: L("Downloads")) {
            if let model { AccountDownloadsContent(model: model, onOpen: open, onPlay: play) }
        }
        .task {
            if model == nil { model = AccountDownloadsModel(source: source ?? AccountServerDownloadsSource(api: account.api)) }
        }
        .task(id: TaskKey(scope: model?.scope, active: phase == .active, ready: model != nil)) {
            guard let model, phase == .active else { return }
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private struct TaskKey: Hashable { var scope: DownloadScope?; var active: Bool; var ready: Bool }

    private func open(_ d: DownloadsPage.Item) {
        if let id = d.libraryAlbumId { nav.push(.album(id: id)) }
    }

    private func play(_ d: DownloadsPage.Item) {
        guard let id = d.libraryAlbumId, let model else { return }
        Task {
            guard let tracks = try? await model.source.albumTracks(id), !tracks.isEmpty else { return }
            player.play(tracks, startAt: 0, context: "album:\(id)")
        }
    }
}

private struct AccountDownloadsContent: View {
    let model: AccountDownloadsModel
    var onOpen: (DownloadsPage.Item) -> Void
    var onPlay: (DownloadsPage.Item) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { ctx in
            let now = ctx.date.timeIntervalSince1970 * 1000
            VStack(alignment: .leading, spacing: 0) {
                Text(L("Downloads")).textStyle(.pageTitle).foregroundStyle(theme.fg)
                    .padding(.top, 8).accessibilityAddTraits(.isHeader)
                head
                if let line = AccountDownloadsLogic.watcherLine(model.data?.watcher, now: now) {
                    Text(line).font(.system(size: 13)).foregroundStyle(theme.fgDim).padding(.top, -4).padding(.bottom, 14)
                }
                if let e = model.error {
                    Text(e).font(.system(size: 14)).foregroundStyle(theme.fgDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12).padding(.horizontal, 16)
                        .background(theme.field, in: RoundedRectangle(cornerRadius: 8))
                        .padding(.vertical, 16)
                }
                if model.data == nil && model.error == nil {
                    Text(L("Loading…")).foregroundStyle(theme.fgDim).padding(.vertical, 32)
                }
                if let data = model.data {
                    if data.items.isEmpty { empty }
                    ForEach(AccountDownloadsLogic.sections, id: \.state) { s in
                        let list = data.items.filter { $0.state == s.state }
                        if !list.isEmpty { section(s, count: list.count, data: data, now: now) }
                    }
                }
            }
            .padding(.horizontal, Spacing.gutter)
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Chip(L("Yours"), on: model.scope == .mine) { model.setScope(.mine) }
                Chip(L("Everyone"), on: model.scope == .all) { model.setScope(.all) }
            }
            let summary = AccountDownloadsLogic.summary(model.data?.items ?? [])
            if !summary.isEmpty {
                // Wraps like the web's flex row.
                AccountFlowRow(spacing: 14) {
                    ForEach(summary, id: \.state) { e in
                        Text(e.text).font(.system(size: 14))
                            .foregroundStyle(e.state == "downloading" ? theme.green : e.state == "stuck" || e.state == "failed" ? theme.danger : theme.fgDim)
                    }
                }
            }
        }
        .padding(.top, 4).padding(.bottom, 8)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.scope == .mine ? L("Nothing requested yet") : L("The queue is empty"))
                .font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg)
            Text(model.scope == .mine
                 ? L("Request an album from an artist page, or make a generated playlist: songs it suggests that you do not have yet show up here while they download.")
                 : L("Nobody is downloading anything right now."))
                .foregroundStyle(theme.fgDim).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 32)
    }

    private func section(_ s: AccountDownloadsLogic.Section, count: Int, data: DownloadsPage, now: Double) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(L(s.heading)).font(.system(size: 20, weight: .bold)).foregroundStyle(theme.fg)
                Text("\(count)").font(.system(size: 14)).foregroundStyle(theme.fgDim)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            .padding(.bottom, 8)
            if s.state == "stuck" {
                Text(L("No new song for {time} or more. Soulseek keeps looking; if nothing turns up it moves to Failed with the reason. Retry also tries torrents.",
                       ["time": AccountDownloadsLogic.duration(ms: data.stuckAfterMs ?? 86_400_000)]))
                    .font(.system(size: 13)).foregroundStyle(theme.fgDim).fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 8)
            }
            ForEach(AccountDownloadsLogic.shown(data.items, state: s.state)) { d in
                AccountDownloadsRow(item: d, watcher: data.watcher, now: now, retrying: model.retrying == d.id,
                             onOpen: { onOpen(d) }, onPlay: { onPlay(d) },
                             onRetry: { Task { ToastCenter.shared.show(await model.retry(d)) } })
            }
        }
        .padding(.top, 24).padding(.bottom, 8)
    }
}

private struct AccountDownloadsRow: View {
    let item: DownloadsPage.Item
    let watcher: DownloadsPage.Watcher?
    let now: Double
    let retrying: Bool
    var onOpen: () -> Void
    var onPlay: () -> Void
    var onRetry: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let status = AccountDownloadsLogic.statusLine(item, watcher: watcher, now: now)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                CoverImage(.url(item.image.flatMap(URL.init(string:))), size: 48, shape: .rounded(Radius.art), placeholder: .chip)
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.system(size: 16, weight: .medium)).foregroundStyle(theme.fg).lineLimit(1)
                    Text(AccountDownloadsLogic.meta(item)).font(.system(size: 14)).foregroundStyle(theme.fgDim).lineLimit(1)
                    if let n = item.note, !n.isEmpty { Text(n).font(.system(size: 13)).foregroundStyle(theme.fgDim) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { if item.libraryAlbumId != nil { onOpen() } }
                .accessibilityAddTraits(item.libraryAlbumId != nil ? .isButton : [])
            }
            if let p = AccountDownloadsLogic.progress(item) {
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(theme.fg(0.14))
                        Capsule().fill(item.state == "done" ? theme.fgDim : item.state == "stuck" ? theme.danger : theme.green)
                            .frame(width: g.size.width * p)
                            .animation(.timingCurve(0.3, 0, 0, 1, duration: 0.6), value: p)
                    }
                }
                .frame(height: 4)
                .padding(.top, 8)
                .accessibilityHidden(true)
            }
            HStack(spacing: 10) {
                Text(status.text).font(.system(size: 13)).foregroundStyle(status.warn ? theme.danger : theme.fgDim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                switch AccountDownloadsLogic.action(item) {
                case .play?: pill(L("Play"), disabled: false, action: onPlay)
                case .retry?: pill(retrying ? L("Retrying…") : L("Retry"), disabled: retrying, action: onRetry)
                case nil: EmptyView()
                }
            }
            .frame(minHeight: 28)
            .padding(.top, 6)
        }
        .padding(8)
    }

    private func pill(_ title: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                .padding(.vertical, 5).padding(.horizontal, 14)
                .overlay(Capsule().strokeBorder(theme.fgDim, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
    }
}

/// A wrapping row (CSS `flex-wrap`).
struct AccountFlowRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let w = rows.map { $0.width }.max() ?? 0
        let h = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: proposal.width ?? w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
                x += s.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row { var items: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for i in subviews.indices {
            let s = subviews[i].sizeThatFits(.unspecified)
            let extra = rows[rows.count - 1].items.isEmpty ? s.width : s.width + spacing
            if rows[rows.count - 1].width + extra > width, !rows[rows.count - 1].items.isEmpty {
                rows.append(Row())
            }
            let r = rows.count - 1
            rows[r].width += rows[r].items.isEmpty ? s.width : s.width + spacing
            rows[r].height = max(rows[r].height, s.height)
            rows[r].items.append(i)
        }
        return rows.filter { !$0.items.isEmpty }
    }
}
