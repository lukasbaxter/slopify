import SwiftUI

/// Listening history / stats (UI.md 7.5; web components/History.jsx, phone layout).
struct HistoryView: View {
    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme

    enum StatsState: Equatable { case loading, loaded(HistoryStats), failed(String) }

    @State private var range: AccountHistoryLogic.Range = HistoryView.storedRange()
    @State private var stats: [AccountHistoryLogic.Range: StatsState] = [:]
    @State private var recent: [HistoryPage.Entry]?
    @State private var showAll = false
    @State private var loadingMore = false
    @State private var done = false

    private var locale: Locale { Localizer.shared.locale }
    private var name: String { account.user?.name.isEmpty == false ? account.user!.name : L("You") }

    var body: some View {
        // No `.hero` on this page: the bar is `color-mix(--hero 55%, --page)` with the default
        // --hero on dark themes, plain `--page` on light ones (app.css:61).
        DetailScaffold(title: L("Listening history"), heroColor: theme.isLight ? theme.rgb.page : Theme.Fixed.defaultHero) {
            hero
            VStack(alignment: .leading, spacing: 0) {
                rangeChips
                statsBlock.padding(.horizontal, Spacing.gutter)
                if case .loaded(let s)? = stats[range], s.connected { sections(s) }
            }
        }
        .background(theme.page.ignoresSafeArea())
        .task(id: range) { await loadStats(range) }
        .task { await loadRecent() }
    }

    // MARK: hero (7.5.2)

    private var hero: some View {
        let st: HistoryStats? = { if case .loaded(let s)? = stats[range] { return s } else { return nil } }()
        return VStack(spacing: 16) {
            AccountAvatar(userId: account.user?.id, name: name, size: 128, background: theme.chip,
                          initialSize: 56, initialWeight: .heavy, initialColor: theme.fg)
            VStack(spacing: 0) {
                Text(name).font(.system(size: 24, weight: .heavy)).foregroundStyle(theme.fg)
                    .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                Text("@" + (account.user?.name ?? "").lowercased()).font(.system(size: 16)).foregroundStyle(theme.fgSub)
                if let st, st.connected {
                    HStack(spacing: 0) {
                        Text(L("{n} streams", ["n": AccountHistoryLogic.number(st.total, locale: locale)]))
                        if st.spotify > 0 {
                            dot
                            Text(L("{n} from Spotify", ["n": AccountHistoryLogic.number(st.spotify, locale: locale)]))
                        }
                        dot
                        Button(L("Edit profile")) { nav.push(.settings) }
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(theme.green)
                            .buttonStyle(.pressFade)
                    }
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub)
                    .padding(.top, 8)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .padding(.top, Shell.topBar)
        .modifier(AccountHistoryTopInset())
        .padding(.horizontal, Spacing.gutter)
        .background {
            LinearGradient(stops: [.init(color: theme.card, location: 0), .init(color: theme.card, location: 0.7),
                                   .init(color: theme.page, location: 1)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        }
    }

    private var dot: some View {
        Rectangle().fill(theme.fgSub).frame(width: 4, height: 4).padding(.horizontal, 8)
    }

    // MARK: range chips (7.5.3)

    private var rangeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AccountHistoryLogic.Range.allCases) { r in
                    Chip(r.label(), on: r == range, small: true) { select(r) }
                }
            }
            .padding(.horizontal, Spacing.gutter)
        }
        .padding(.bottom, 16)
    }

    private func select(_ r: AccountHistoryLogic.Range) {
        range = r
        UserDefaults.standard.set(r.rawValue, forKey: AccountHistoryLogic.Range.storageKey)
    }

    static func storedRange() -> AccountHistoryLogic.Range {
        UserDefaults.standard.string(forKey: AccountHistoryLogic.Range.storageKey).flatMap(AccountHistoryLogic.Range.init(rawValue:)) ?? .default
    }

    // MARK: stat cards (7.5.4)

    @ViewBuilder
    private var statsBlock: some View {
        switch stats[range] ?? .loading {
        case .loading:
            grid {
                ForEach(0..<6, id: \.self) { _ in
                    VStack(alignment: .leading, spacing: 0) {
                        GeometryReader { g in Capsule().fill(theme.card).frame(width: g.size.width * 0.5, height: 28) }.frame(height: 36)
                        GeometryReader { g in Capsule().fill(theme.card).frame(width: g.size.width * 0.7, height: 16) }.frame(height: 16)
                    }
                }
            }
            .skeletonPulse()
            .accessibilityHidden(true)
        case .failed(let e):
            Text(L("Could not load history: {error}", ["error": e])).font(.system(size: 14)).foregroundStyle(theme.fgFaint)
        case .loaded(let s) where !s.connected:
            ZStack {
                grid {
                    ForEach(["minutes streamed", "hours streamed", "streams"], id: \.self) { l in
                        statCard(value: "?", label: L(l), delta: nil)
                    }
                }
                .blur(radius: 4)
                .accessibilityHidden(true)
                VStack(spacing: 0) {
                    Text(L("Connect ListenBrainz under Settings › Scrobbling to see your streaming history"))
                        .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgFaint).multilineTextAlignment(.center)
                    Button { nav.push(.settings) } label: {
                        Text(L("Open settings")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.onFg)
                            .padding(.horizontal, 16).frame(minHeight: 32).background(theme.fg, in: Capsule())
                    }
                    .buttonStyle(.pressFade)
                    .padding(.top, 8)
                }
            }
        case .loaded(let s):
            grid {
                ForEach(AccountHistoryLogic.cards(s), id: \.label) { c in
                    statCard(value: AccountHistoryLogic.number(c.value, locale: locale), label: L(c.label),
                             delta: AccountHistoryLogic.delta(now: c.value, before: c.before))
                }
            }
        }
    }

    private func grid<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .topLeading), GridItem(.flexible(), spacing: 12, alignment: .topLeading)],
                  alignment: .leading, spacing: 12, content: content)
    }

    private func statCard(value: String, label: String, delta: Int?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(value).font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg).lineLimit(1)
                if let delta { AccountHistoryDelta(pct: delta) }
            }
            Text(label).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: sections (7.5.5)

    @ViewBuilder
    private func sections(_ s: HistoryStats) -> some View {
        AccountHistorySectionHead(title: L("Top genres"), description: AccountHistoryLogic.description("Your top genres {range}", bare: "Your top genres", range: range))
        if s.topGenres.isEmpty { AccountHistoryEmpty() } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(s.topGenres, id: \.id) { g in
                        Text(g.name.lowercased()).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fg)
                            .padding(.vertical, 8).padding(.horizontal, 16)
                            .background(theme.card, in: Capsule())
                    }
                }
                .padding(.horizontal, Spacing.gutter).padding(.bottom, 12)
            }
        }

        AccountHistorySectionHead(title: L("Top tracks"), description: AccountHistoryLogic.description("Your top tracks {range}", bare: "Your top tracks", range: range))
        carousel(s.topTracks, height: 276) { i, t in
            AccountHistoryTrackCard(index: i, track: t, locale: locale,
                             onOpen: { if let a = t.albumId { nav.push(.album(id: a)) } },
                             onArtist: { if let a = t.artistId { nav.push(.artist(id: a)) } })
        }

        AccountHistorySectionHead(title: L("Top artists"), description: AccountHistoryLogic.description("Your top artists {range}", bare: "Your top artists", range: range))
        carousel(s.topArtists, height: 262) { i, a in
            AccountHistoryArtistCard(index: i, artist: a, locale: locale) { if let id = a.artistId { nav.push(.artist(id: id)) } }
        }

        AccountHistorySectionHead(title: L("Top albums"), description: AccountHistoryLogic.description("Your top albums {range}", bare: "Your top albums", range: range))
        carousel(s.topAlbums, height: 255) { i, a in
            AccountHistoryAlbumCard(index: i, album: a, locale: locale) { if let id = a.albumId { nav.push(.album(id: id)) } }
        }

        AccountHistorySectionHead(title: L("Streams and minutes streamed per day"),
                           description: AccountHistoryLogic.description("Your listening over time {range}", bare: "Your listening over time", range: range))
        perDay(s).padding(.horizontal, Spacing.gutter)

        AccountHistorySectionHead(title: L("Listening clocks"),
                           description: AccountHistoryLogic.description("Your listening habits throughout the day {range}", bare: "Your listening habits throughout the day", range: range))
        VStack(spacing: 8) {
            AccountHistoryClock(values: s.byHour) { AccountHistoryLogic.streams(Int($0), locale: locale) }
            Text(L("streams")).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub)
            AccountHistoryClock(values: s.byHourSeconds ?? s.byHour) { v in
                s.byHourSeconds != nil ? AccountHistoryLogic.hm(v) : AccountHistoryLogic.streams(Int(v), locale: locale)
            }
            Text(L("minutes streamed")).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub)
        }
        .padding(.horizontal, Spacing.gutter)

        AccountHistorySectionHead(title: L("Recent streams"), description: L("Your recently played tracks"))
        recentList.padding(.horizontal, Spacing.gutter)
    }

    private func carousel<T, Cell: View>(_ items: [T], height: CGFloat, @ViewBuilder cell: @escaping (Int, T) -> Cell) -> some View {
        Group {
            if items.isEmpty { AccountHistoryEmpty() } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 16) {
                        ForEach(items.indices, id: \.self) { i in
                            cell(i, items[i]).frame(width: 160, height: height, alignment: .top)
                        }
                    }
                    .padding(.horizontal, Spacing.gutter)
                }
            }
        }
    }

    private func perDay(_ s: HistoryStats) -> some View {
        let pts = AccountHistoryLogic.buckets(s.perDay, locale: locale)
        let avg = AccountHistoryLogic.averages(s)
        return VStack(spacing: 16) {
            HStack(spacing: 12) {
                avgCard(AccountHistoryLogic.number(avg.streams, locale: locale), L("average streams per day"))
                avgCard(AccountHistoryLogic.number(avg.minutes, locale: locale), L("average minutes per day"))
            }
            AccountHistoryLineChart(title: L("Daily"), points: pts)
            AccountHistoryLineChart(title: L("Cumulative"), points: AccountHistoryLogic.cumulative(pts))
        }
    }

    private func avgCard(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(value).font(.system(size: 20, weight: .bold)).foregroundStyle(theme.green)
            Text(label).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.fg)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 14).padding(.horizontal, 16)
        .background(theme.card, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
    }

    // MARK: recent streams

    @ViewBuilder
    private var recentList: some View {
        if let recent {
            if recent.isEmpty {
                VStack(spacing: 8) {
                    IconView(.historyMusicOff, size: 48).foregroundStyle(theme.fgFaint)
                    Text(L("Looks like you don't have any recent streams")).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub)
                }
                .frame(maxWidth: .infinity).padding(16)
            } else {
                let rows = showAll ? recent : Array(recent.prefix(8))
                let groups = AccountHistoryLogic.groupByDay(rows, at: { Date(timeIntervalSince1970: $0.at / 1000) }, locale: locale)
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(groups.indices, id: \.self) { g in
                        Text(groups[g].day).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).padding(.vertical, 8)
                        ForEach(Array(groups[g].rows.enumerated()), id: \.offset) { _, e in
                            AccountHistoryRecentRow(entry: e) { nav.push(.album(id: e.track.albumId)) }
                        }
                    }
                    if !showAll && recent.count > 8 {
                        Button { showAll = true } label: {
                            Text(L("show all").uppercased()).font(.system(size: 14, weight: .bold)).foregroundStyle(theme.fgFaint)
                        }
                        .buttonStyle(.pressFade)
                        .padding(.vertical, 12)
                    }
                    if showAll && !done {
                        AccountHistorySpinner(visible: loadingMore)
                            .frame(maxWidth: .infinity).frame(height: 48)
                            .id(recent.count)
                            .onAppear { Task { await loadMore() } }
                    }
                    if showAll && done {
                        Text(L("No streams to load!")).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgFaint)
                            .frame(maxWidth: .infinity).padding(16)
                    }
                }
            }
        } else {
            VStack(spacing: 12) {
                ForEach(0..<4, id: \.self) { _ in
                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 8).fill(theme.card).frame(width: 48, height: 48)
                        Capsule().fill(theme.card).frame(maxWidth: 240).frame(height: 16)
                        Spacer(minLength: 8)
                        Capsule().fill(theme.card).frame(width: 64, height: 16)
                    }
                }
            }
            .skeletonPulse()
            .accessibilityHidden(true)
        }
    }

    // MARK: data

    private func loadStats(_ r: AccountHistoryLogic.Range) async {
        if let cur = stats[r], cur != .loading { return }
        stats[r] = .loading
        do {
            let s = try await account.api.historyStats(range: r.rawValue)
            stats[r] = .loaded(s)
        } catch is CancellationError {
            stats[r] = nil
        } catch {
            stats[r] = .failed(error.localizedDescription)
        }
    }

    private func loadRecent() async {
        guard recent == nil else { return }
        recent = (try? await account.api.history(limit: 100))?.items ?? []
    }

    private func loadMore() async {
        guard let last = recent?.last, !loadingMore, !done else { return }
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await account.api.history(limit: 100, before: last.at) else { return }
        if page.items.isEmpty { done = true } else { recent?.append(contentsOf: page.items) }
    }
}

/// Pads the hero by the scaffold's top inset (only readable inside the scaffold).
private struct AccountHistoryTopInset: ViewModifier {
    @Environment(\.detailTopInset) private var inset
    func body(content: Content) -> some View { content.padding(.top, inset) }
}
