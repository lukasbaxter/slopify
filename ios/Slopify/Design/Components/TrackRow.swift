import SwiftUI

/// The shared track row (UI.md 5.4), phone layout. Data-driven: the screen passes state and
/// closures; the row never plays, navigates or fetches (except its artwork).
///
/// Variants: plain (album pages), `showArt` (playlists, Liked, search, Popular, recommended),
/// `number` (artist Popular: index column with the now-playing bars), `subtitle` override
/// (Popular play counts), downloaded mark, unavailable (offline and not downloaded: 40 %),
/// highlighted (opened from a link), lyric snippet (Liked "find" by lyrics).
///
///     TrackRow(track: t, showArt: true, isCurrent: player.currentId == t.id,
///              onTap: { play(i) }, onMore: { menu = t })
struct TrackRow: View {
    let track: Track
    var showArt = false
    /// Popular list: 1-based number in a 20 pt index column.
    var number: Int? = nil
    /// This track is the player's current track (green title).
    var isCurrent = false
    /// Current and audio playing (Popular shows the animated bars).
    var isPlaying = false
    var isDownloaded = false
    var isUnavailable = false
    var isHighlighted = false
    /// Replaces the artist names (e.g. play count).
    var subtitle: String? = nil
    /// Lyric match line: `text` with the matched words in `matches` (ranges into text).
    var snippet: LyricSnippet? = nil

    var onTap: () -> Void = {}
    var onMore: (() -> Void)? = nil
    /// Tap on the artwork (open the album).
    var onArt: (() -> Void)? = nil
    /// Finger down: pre-warm the stream.
    var onTouchDown: (() -> Void)? = nil
    var onSnippet: (() -> Void)? = nil

    @Environment(\.theme) private var theme

    struct LyricSnippet: Hashable {
        var text: String
        var matches: [Range<String.Index>] = []
    }

    /// "A, B" or the album artist.
    static func artistLine(_ t: Track) -> String {
        let names = t.artists.filter { !$0.isEmpty }
        return names.isEmpty ? (t.albumArtist.isEmpty ? t.artist : t.albumArtist) : names.joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 12) {
            if let number { indexColumn(number) }
            if showArt {
                CoverImage(.init(track), size: 48, shape: .rounded(Radius.rowArt), placeholder: .cardHover)
                    .frame(width: 48, height: 48)
                    .onTapGesture { (onArt ?? onTap)() }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .textStyle(.rowTitle)
                    .foregroundStyle(isCurrent ? theme.accentInk : theme.fg)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    if isDownloaded {
                        IconView(.downloadedMark, size: 12).foregroundStyle(theme.green)
                            .accessibilityLabel(L("Downloaded"))
                    }
                    Text(subtitle ?? Self.artistLine(track)).lineLimit(1)
                }
                .textStyle(.subLine)
                .foregroundStyle(theme.fgSub)
                if let snippet { snippetLine(snippet) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let onMore {
                Button(action: onMore) {
                    IconView(.dots, size: 16).foregroundStyle(theme.fgSub).frame(width: 40, height: 40)
                }
                .buttonStyle(.pressFade)
                .padding(.trailing, -12)
                .accessibilityLabel(L("More options"))
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, Spacing.gutter)
        .frame(minHeight: Shell.trackRow)
        .background { if isHighlighted { theme.tintHi.overlay(Rectangle().strokeBorder(theme.tintPress, lineWidth: 1)) } }
        .pressable(.row, onTap: onTap, onLongPress: onMore, onTouchDown: onTouchDown)
        .opacity(isUnavailable ? 0.4 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private func indexColumn(_ n: Int) -> some View {
        Group {
            if isCurrent && isPlaying { NowPlayingBars() }
            else {
                Text(verbatim: "\(n)").font(.system(size: 16)).monospacedDigit()
                    .foregroundStyle(isCurrent ? theme.accentInk : theme.fgSub)
            }
        }
        .frame(width: 20, height: 24)
    }

    private func snippetLine(_ s: LyricSnippet) -> some View {
        HStack(spacing: 8) {
            Text(L("Lyrics"))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.fgDim)
                .padding(.horizontal, 6)
                .frame(height: 15)
                .background(theme.fg(0.1), in: RoundedRectangle(cornerRadius: 3))
            Text(highlighted(s)).font(.system(size: 12)).foregroundStyle(theme.fgDim).lineLimit(1)
        }
        .padding(.top, 3)
        .onTapGesture { onSnippet?() }
    }

    private func highlighted(_ s: LyricSnippet) -> AttributedString {
        var a = AttributedString(s.text)
        for r in s.matches {
            guard let lo = AttributedString.Index(r.lowerBound, within: a), let hi = AttributedString.Index(r.upperBound, within: a) else { continue }
            a[lo..<hi].foregroundColor = theme.fg
            a[lo..<hi].font = .system(size: 12, weight: .medium)
        }
        return a
    }
}

extension Track {
    /// A stand-in track for previews and skeleton-free layout tests.
    static func preview(_ title: String = "Paranoid Android", artist: String = "Radiohead") -> Track {
        Track(id: UUID().uuidString, title: title, artist: artist, artists: [artist], artistIds: [], albumId: "", album: "OK Computer",
              albumArtist: artist, trackNo: 2, discNo: 1, year: 1997, genres: nil, durationMs: 383000, codec: "FLAC", bitrate: nil,
              cover: nil, format: nil, gain: nil, addedAt: nil, plays: nil)
    }
}

#Preview("TrackRow variants") {
    ScrollView {
        VStack(spacing: 0) {
            TrackRow(track: .preview(), onMore: {})
            TrackRow(track: .preview("Karma Police"), showArt: true, isCurrent: true, onMore: {})
            TrackRow(track: .preview("No Surprises"), showArt: true, isDownloaded: true, onMore: {})
            TrackRow(track: .preview("Let Down"), number: 1, isCurrent: true, isPlaying: true, subtitle: "1,234", onMore: {})
            TrackRow(track: .preview("Airbag"), number: 2, subtitle: "987", onMore: {})
            TrackRow(track: .preview("Lucky"), showArt: true, isUnavailable: true, onMore: {})
            TrackRow(track: .preview("Exit Music"), showArt: true, isHighlighted: true, onMore: {})
            TrackRow(track: .preview("Climbing Up the Walls"), showArt: true,
                     snippet: .init(text: "and either way you turn", matches: []), onMore: {})
        }
    }
    .background(Theme.default.page)
}
