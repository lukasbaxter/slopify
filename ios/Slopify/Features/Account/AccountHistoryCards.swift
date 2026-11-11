import SwiftUI

/// Sticky-less section head (`.sf-section-head`): h2 24/700, description 14 `--fg-sub` one line.
struct AccountHistorySectionHead: View {
    let title: String
    let description: String
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.system(size: 24, weight: .bold)).foregroundStyle(theme.fg).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Text(description).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 28).padding(.bottom, 12)
        .padding(.horizontal, Spacing.gutter)
    }
}

struct AccountHistoryEmpty: View {
    @Environment(\.theme) private var theme
    var body: some View {
        Text(L("Not enough data to complete this list")).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgFaint)
            .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(16)
    }
}

/// `+N%` green / `-N%` red / `0%` grey, 12/700 on `--card`, radius 6, padding 1/6.
struct AccountHistoryDelta: View {
    let pct: Int
    @Environment(\.theme) private var theme

    var body: some View {
        Text(pct > 0 ? "+\(pct)%" : "\(pct)%")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(pct > 0 ? theme.green : pct < 0 ? Theme.Fixed.deltaDown : theme.fgSub)
            .padding(.vertical, 1).padding(.horizontal, 6)
            .background(theme.card, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// Press: scale .95 over 0.3 s.
private struct AccountHistoryCardPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.95 : 1).animation(.easeInOut(duration: 0.3), value: configuration.isPressed)
    }
}

private struct AccountHistorySquare: View {
    let source: CoverSource?
    var round = false
    @Environment(\.theme) private var theme
    var body: some View {
        ZStack {
            theme.card
            if let source { CoverImage(source, size: 160, shape: round ? .circle : .rounded(0), placeholder: .none) }
        }
        .frame(width: 160, height: 160)
        .clipShape(round ? AnyShape(Circle()) : AnyShape(Rectangle()))
    }
}

struct AccountHistoryTrackCard: View {
    let index: Int
    let track: HistoryStats.TopTrack
    let locale: Locale
    var onOpen: () -> Void
    var onArtist: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 8) {
                    AccountHistorySquare(source: (track.albumId ?? track.id).map { .album(id: $0, art: nil) })
                    Text("\(index + 1). \(track.name)").font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg)
                        .lineLimit(2).multilineTextAlignment(.leading)
                }
            }
            .buttonStyle(AccountHistoryCardPress())
            Text(meta).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(2)
                .tint(theme.fgSub)
                .environment(\.openURL, OpenURLAction { _ in onArtist(); return .handled })
                .padding(.top, 4)
        }
    }

    /// `{n} minutes • {n} streams • artist`, the artist a link when it has an id.
    private var meta: AttributedString {
        var a = AttributedString(AccountHistoryLogic.minutes(seconds: track.seconds, locale: locale) + " • " + AccountHistoryLogic.streams(track.count, locale: locale) + " • ")
        var artist = AttributedString(track.artist ?? "")
        if track.artistId != nil { artist.link = URL(string: "slopify-artist:open") }
        a += artist
        return a
    }
}

struct AccountHistoryArtistCard: View {
    let index: Int
    let artist: HistoryStats.TopArtist
    let locale: Locale
    var onOpen: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: 8) {
                if let id = artist.artistId {
                    AccountHistorySquare(source: .artist(id: id, image: nil), round: true)
                } else {
                    Circle().fill(theme.card).frame(width: 160, height: 160)
                        .overlay { Text(AccountProfileLogic.initial(artist.name)).font(.system(size: 48)).foregroundStyle(theme.fgSub) }
                }
                Text("\(index + 1). \(artist.name)").font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg)
                    .lineLimit(2).multilineTextAlignment(.center)
                Text(AccountHistoryLogic.minutes(seconds: artist.seconds, locale: locale) + " • " + AccountHistoryLogic.streams(artist.count, locale: locale))
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(2).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(AccountHistoryCardPress())
    }
}

struct AccountHistoryAlbumCard: View {
    let index: Int
    let album: HistoryStats.TopAlbum
    let locale: Locale
    var onOpen: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 8) {
                AccountHistorySquare(source: album.albumId.map { .album(id: $0, art: nil) })
                Text("\(index + 1). \(album.name)").font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg)
                    .lineLimit(2).multilineTextAlignment(.leading)
                Text(AccountHistoryLogic.minutes(seconds: album.seconds, locale: locale) + " • " + AccountHistoryLogic.streams(album.count, locale: locale))
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(1)
            }
        }
        .buttonStyle(AccountHistoryCardPress())
    }
}

/// One recent stream: 48 cover, title, `artist • album`, relative time, divider. Tap opens the album.
struct AccountHistoryRecentRow: View {
    let entry: HistoryPage.Entry
    var onOpen: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    CoverImage(.init(entry.track), size: 48, shape: .rounded(0), placeholder: .none)
                        .frame(width: 48, height: 48).background(theme.card)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(entry.track.title).font(.system(size: 18, weight: .bold)).foregroundStyle(theme.fg).lineLimit(1)
                        Text(AccountHistoryLogic.recentSubtitle(entry.track)).font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    TimelineView(.periodic(from: .now, by: 30)) { ctx in
                        Text(AccountHistoryLogic.fromNow(seconds: ctx.date.timeIntervalSince1970 - entry.at / 1000))
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(theme.fgSub).lineLimit(1).fixedSize()
                    }
                    .padding(.leading, 8)
                }
                Rectangle().fill(theme.card).frame(height: 1).padding(.vertical, 8)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
    }
}

/// 24 pt ring: 3 pt `--card` with a `--green` top arc, 0.8 s linear spin.
struct AccountHistorySpinner: View {
    var visible: Bool
    @Environment(\.theme) private var theme
    @State private var spin = false

    var body: some View {
        ZStack {
            Circle().stroke(theme.card, lineWidth: 3)
            Circle().trim(from: 0, to: 0.25).stroke(theme.green, style: StrokeStyle(lineWidth: 3, lineCap: .butt))
                .rotationEffect(.degrees(spin ? 360 : 0))
        }
        .frame(width: 24, height: 24)
        .opacity(visible ? 1 : 0)
        .onAppear { withAnimation(.linear(duration: 0.8).repeatForever(autoreverses: false)) { spin = true } }
        .accessibilityHidden(true)
    }
}
