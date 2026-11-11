import SwiftUI

/// What one Your Library row shows (UI.md 5.2.8). `entry == nil` is Liked Songs.
struct LibraryRowModel: Identifiable {
    var entry: LibraryEntry?
    var subtitle: String
    var pinned: Bool
    /// Every song kept on this device: the green mark.
    var downloaded = false
    /// Offline + partly kept: `{have} of {total} downloaded • `.
    var partial: String?
    var folderOpen = false

    var id: String { entry?.id ?? LibraryRowModel.likedId }
    var name: String { entry?.name ?? L("Liked Songs") }
    var isChild: Bool { entry?.parent != nil }
    static let likedId = "__liked__"
}

/// List row: 64 pt art (radius 3, circle for artists), 16 pt gap, title 16 + subtitle 13.
struct LibraryListRow: View {
    let model: LibraryRowModel
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 16) {
            LibraryArt(model: model, side: 64)
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 0) {
                Text(model.name).textStyle(.rowTitle).foregroundStyle(theme.fg).lineLimit(1)
                LibrarySubline(model: model)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .padding(.leading, model.isChild ? 20 : 0)
        .frame(height: LibraryLayoutMetrics.listRow)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// Grid cell: square art the cell's width, title 14 up to 2 lines, subtitle 13.
struct LibraryGridCell: View {
    let model: LibraryRowModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            LibraryArt(model: model, side: 180)
                .aspectRatio(1, contentMode: .fit)
                .frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: 0) {
                Text(model.name).font(.system(size: 14)).lineSpacing(14 * 0.3 - 2).foregroundStyle(theme.fg).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                LibrarySubline(model: model)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

enum LibraryLayoutMetrics {
    /// 64 art + 8 + 8.
    static let listRow: CGFloat = 80
    static let gridGap: CGFloat = 16
}

/// `[pin] [mark | partial] subtitle`, 13 pt `--fg-sub`, one line.
private struct LibrarySubline: View {
    let model: LibraryRowModel
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 4) {
            if model.pinned {
                IconView(.pin, size: 13).foregroundStyle(theme.accentInk).accessibilityLabel(L("Pinned"))
            }
            if model.downloaded {
                IconView(.downloadedMark, size: 12).foregroundStyle(theme.green).accessibilityLabel(L("Downloaded"))
            }
            Text((model.partial ?? "") + model.subtitle).lineLimit(1)
        }
        .textStyle(.subLine)
        .foregroundStyle(theme.fgSub)
    }
}

/// Artwork per kind (UI.md 5.2.8).
struct LibraryArt: View {
    let model: LibraryRowModel
    var side: CGFloat
    @Environment(\.theme) private var theme

    var body: some View {
        if let e = model.entry {
            switch e.kind {
            case .playlist:
                CoverImage(.playlist(id: e.id, cover: e.playlist?.cover), size: side, shape: .rounded(Radius.rowArt), placeholder: .cardHover)
            case .album:
                CoverImage(.album(id: e.id, art: e.album?.cover), size: side, shape: .rounded(Radius.rowArt), placeholder: .cardHover)
            case .artist:
                CoverImage(.artist(id: e.id, image: e.artist?.image), size: side, shape: .circle, placeholder: .cardHover)
            case .folder:
                if e.folderCover != nil {
                    // TODO(lead): CoverSource.folder has no cover hash cache-buster (`&c=`); a new picture may show late.
                    CoverImage(.folder(id: e.id), size: side, shape: .rounded(Radius.rowArt), placeholder: .cardHover)
                } else {
                    RoundedRectangle(cornerRadius: Radius.rowArt).fill(theme.cardHover)
                        .overlay { IconView(model.folderOpen ? .folderOpen : .folder, size: 28).foregroundStyle(theme.fgDim) }
                }
            }
        } else {
            LikedCover(radius: Radius.rowArt)
        }
    }
}
