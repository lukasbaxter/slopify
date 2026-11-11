import SwiftUI

/// "Popular releases" row (`.releases .release`): 76 pt art radius 4, name 16 pt, "{year} • {type}"
/// 13 pt 3 pt below; missing releases dimmed with an inline Request pill and no row tap.
struct DetailReleaseRow: View {
    let entry: DetailLogic.Entry
    let request: String?
    var onOpen: (String) -> Void
    var onRequest: (DetailLogic.Entry) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let missing = entry.inLib == nil
        HStack(spacing: 12) {
            art
                .frame(width: 76, height: 76)
                .clipShape(RoundedRectangle(cornerRadius: Radius.art))
                .grayscale(missing ? 0.4 : 0)
                .colorMultiply(Color(white: missing ? 0.75 : 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title).font(.system(size: 16)).foregroundStyle(theme.fg).lineLimit(1)
                Text(entry.subtitle).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if missing { DetailInlineRequestPill(state: request, enabled: entry.mbid != nil) { onRequest(entry) } }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .onTapGesture { if let id = entry.inLib { onOpen(id) } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(missing ? [] : .isButton)
    }

    @ViewBuilder private var art: some View {
        if let id = entry.inLib {
            CoverImage(.album(id: id, art: nil), size: 76, placeholder: .chip)
        } else if let url = entry.image {
            CoverImage(.url(url), size: 76, placeholder: .chip)
        } else {
            ZStack {
                theme.chip
                IconView(.musicNote, size: 28).foregroundStyle(theme.fgFaint)
            }
        }
    }
}

/// The Request pill inline in a release row: 13 pt, padding 6/14, no shadow (`.release .card-request`).
private struct DetailInlineRequestPill: View {
    let state: String?
    var enabled = true
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        let ui = DetailLogic.requestLabel(state)
        Button(action: action) {
            Text(L(ui.key)).font(.system(size: 13, weight: .bold))
                .foregroundStyle(ui.busy ? theme.fg : Color.black)
                .padding(.vertical, 6).padding(.horizontal, 14)
                .background(ui.busy ? theme.tintPress : Color.white, in: Capsule())
        }
        .buttonStyle(.pressFade)
        .disabled(ui.busy || !enabled)
        .accessibilityHint(L("Download this release into your library"))
    }
}

/// "Couldn’t load the full discography. Retry" (offline: "Not available offline.").
struct DetailDiscographyFailedNote: View {
    var offline: Bool
    var retry: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if offline {
                PlaceholderNote(text: L("Not available offline."))
            } else {
                HStack(spacing: 4) {
                    Text(L("Couldn’t load the full discography."))
                    Button(L("Retry"), action: retry).foregroundStyle(theme.fg).buttonStyle(.pressFade)
                }
                .font(.system(size: 13)).foregroundStyle(theme.fgSub)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16).padding(.vertical, 8)
            }
        }
    }
}

/// "Discography" after "See discography" (UI.md 6.3.7 §3): hint, the two filter groups in one
/// sideways line, a 2-column grid. Keeps its tallest height so filtering never moves the page.
struct DetailDiscographySection: View {
    let model: DetailArtistModel
    var onOpen: (String) -> Void
    var onRequest: (DetailLogic.Entry) -> Void
    var onRetry: () -> Void
    @Environment(\.theme) private var theme
    @State private var type: DetailLogic.TypeFilter = .all
    @State private var lib: DetailLogic.LibFilter = .all
    @State private var minHeight: CGFloat = 0

    var body: some View {
        let all = model.entries
        let shown = DetailLogic.filtered(all, type: type, lib: lib)
        let types = DetailLogic.typeFilters(all)
        let have = all.filter { $0.inLib != nil }.count
        let hint: String? = model.discog == .loading ? L("Loading…")
            : all.isEmpty ? nil : L("{have} of {total} in your library", ["have": have, "total": all.count])
        VStack(alignment: .leading, spacing: 0) {
            DetailSectionHeader(title: L("Discography"), hint: hint)
            if model.discog == .failed {
                DetailDiscographyFailedNote(offline: Connectivity.shared.offline, retry: onRetry)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    HStack(spacing: 8) {
                        ForEach(DetailLogic.LibFilter.allCases, id: \.self) { f in Chip(L(f.key), on: lib == f) { lib = f } }
                    }
                    if types.count > 2 {
                        HStack(spacing: 8) {
                            ForEach(types, id: \.self) { f in Chip(L(f.key), on: type == f) { type = f } }
                        }
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) { Rectangle().fill(theme.fg(0.2)).frame(width: 1) }
                        .padding(.leading, 4)
                    }
                }
                .padding(.horizontal, Spacing.gutter)
            }
            .padding(.bottom, 12)
            CardGrid(items: shown) { e in card(e) }
        }
        .background(GeometryReader { g in
            Color.clear.onAppear { grow(g.size.height) }.onChange(of: g.size.height) { _, h in grow(h) }
        })
        .frame(minHeight: minHeight, alignment: .top)
    }

    private func grow(_ h: CGFloat) { if h > minHeight { minHeight = h } }

    @ViewBuilder private func card(_ e: DetailLogic.Entry) -> some View {
        if let id = e.inLib {
            MediaCard(.album(id: id, art: nil), title: e.title, subtitle: e.subtitle) { onOpen(id) }
        } else {
            let ui = DetailLogic.requestLabel(model.requestState(e))
            MediaCard(title: e.title, subtitle: e.subtitle, missing: true,
                      request: RequestPill(title: L(ui.key), busy: ui.busy) { if e.mbid != nil { onRequest(e) } },
                      action: {}) {
                CoverImage(.url(e.image), size: 158, shape: .rounded(Radius.card), placeholder: .note)
            }
        }
    }
}
