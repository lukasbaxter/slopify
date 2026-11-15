import SwiftUI
import WidgetKit

@main
struct SlopifyWidgetBundle: WidgetBundle {
    var body: some Widget {
        PlayerWidget()
        SongRadioWidget()
    }
}

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

/// One entry: the app reloads the timelines whenever what is playing changes, and the
/// progress line runs by itself in between.
struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: .now, snapshot: WidgetSnapshot()) }
    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: .now, snapshot: WidgetStore.read() ?? WidgetSnapshot()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: WidgetStore.read() ?? WidgetSnapshot())], policy: .never))
    }
}

/// Small: the song. Medium: the song over the four most recent shortcuts.
struct PlayerWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SlopifyPlayer", provider: SnapshotProvider()) { entry in
            PlayerWidgetView(entry: entry)
        }
        .configurationDisplayName("Slopify")
        .description("What is playing, and your recent music.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

/// Medium: a big cover, and a strip that opens the song's radio.
struct SongRadioWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "SlopifySongRadio", provider: SnapshotProvider()) { entry in
            SongRadioView(entry: entry)
        }
        .configurationDisplayName("Song radio")
        .description("What is playing, and its radio one tap away.")
        .supportedFamilies([.systemMedium])
        .contentMarginsDisabled()
    }
}

// MARK: - Pieces

private enum Look {
    static let empty = Color(red: 30 / 255, green: 215 / 255, blue: 96 / 255)
    static let fallback = Color(red: 0.16, green: 0.16, blue: 0.17)
    static let sub = Color.white.opacity(0.72)

    static func tint(_ now: WidgetSnapshot.Now?) -> Color {
        guard let t = now?.tint, t.count == 3 else { return now == nil ? empty : fallback }
        return Color(red: Double(t[0]) / 255, green: Double(t[1]) / 255, blue: Double(t[2]) / 255)
    }
}

private struct Cover: View {
    let name: String?
    let side: CGFloat
    var radius: CGFloat = 6
    var round = false
    var shadow = false

    var body: some View {
        Group {
            if let url = WidgetStore.coverFile(name), let img = UIImage(contentsOfFile: url.path) {
                Image(uiImage: img).resizable().aspectRatio(contentMode: .fill)
            } else {
                Color.black.opacity(0.2)
            }
        }
        .frame(width: side, height: side)
        .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: radius, style: .continuous)))
        .shadow(color: .black.opacity(shadow ? 0.18 : 0), radius: 4, y: 2)
    }
}

/// The round white button; its glyph takes the widget's colour.
private struct PlayButton: View {
    let playing: Bool
    let tint: Color

    var body: some View {
        Button(intent: TogglePlaybackIntent()) {
            ZStack {
                Circle().fill(.white)
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(tint)
                    .offset(x: playing ? 0 : 1.5)
            }
            .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(playing ? "Pause" : "Play")
    }
}

/// The line along the bottom edge; it runs by itself while the song plays.
private struct ProgressLine: View {
    let now: WidgetSnapshot.Now
    let date: Date

    var body: some View {
        if let span = WidgetLogic.progressSpan(now, at: date) {
            ProgressView(timerInterval: span, countsDown: false, label: { EmptyView() }, currentValueLabel: { EmptyView() })
                .progressViewStyle(.linear)
                .tint(.white)
                .frame(height: 4)
        }
    }
}

private struct Titles: View {
    let now: WidgetSnapshot.Now
    var titleSize: CGFloat
    var artistSize: CGFloat
    var titleLines = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(now.title).font(.system(size: titleSize, weight: .bold)).tracking(-0.2).lineLimit(titleLines)
                .foregroundStyle(.white)
            Text(now.artist).font(.system(size: artistSize)).tracking(-0.1).lineLimit(1)
                .foregroundStyle(Look.sub)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Before anything has played.
private struct EmptyState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(.black.opacity(0.2)).frame(width: 80, height: 80)
            Spacer(minLength: 0)
            Text("Listen to your music").font(.system(size: 14.5, weight: .bold)).tracking(-0.2).lineLimit(2)
                .foregroundStyle(.white)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Player widget

struct PlayerWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SnapshotEntry

    var body: some View {
        let now = entry.snapshot.now
        Group {
            if let now {
                if family == .systemMedium { medium(now) } else { small(now) }
            } else {
                EmptyState()
            }
        }
        .widgetURL(WidgetLink.nowPlaying.url)
        .containerBackground(Look.tint(now), for: .widget)
    }

    private func small(_ now: WidgetSnapshot.Now) -> some View {
        ZStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                Cover(name: now.cover, side: 80, shadow: true)
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 6) {
                    Titles(now: now, titleSize: 14.5, artistSize: 13.5, titleLines: 2)
                    PlayButton(playing: now.playing, tint: Look.tint(now))
                }
            }
            .padding(EdgeInsets(top: 16, leading: 16, bottom: 14, trailing: 16))
            ProgressLine(now: now, date: entry.date)
        }
    }

    private func medium(_ now: WidgetSnapshot.Now) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                Cover(name: now.cover, side: 44, radius: 5)
                Titles(now: now, titleSize: 15.5, artistSize: 14.5)
                PlayButton(playing: now.playing, tint: Look.tint(now))
            }
            .padding(.horizontal, 16)
            .frame(height: 66)
            HStack(spacing: 0) {
                let tiles = Array(entry.snapshot.recents.prefix(WidgetLogic.tileCount))
                ForEach(Array(tiles.enumerated()), id: \.offset) { i, tile in
                    if i > 0 { Spacer(minLength: 0) }
                    if let url = URL(string: tile.link) {
                        Link(destination: url) { Cover(name: tile.cover, side: 68, radius: 4.5, round: tile.round) }
                            .accessibilityLabel(tile.title)
                    }
                }
                if tiles.count < WidgetLogic.tileCount { Spacer(minLength: 0) }
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black.opacity(0.13))
        }
    }
}

// MARK: - Song radio widget

struct SongRadioView: View {
    let entry: SnapshotEntry

    var body: some View {
        let now = entry.snapshot.now
        Group {
            if let now {
                VStack(spacing: 0) {
                    HStack(spacing: 11) {
                        Cover(name: now.cover, side: 84, shadow: true)
                        Titles(now: now, titleSize: 15.5, artistSize: 14.5)
                        PlayButton(playing: now.playing, tint: Look.tint(now))
                    }
                    .padding(.horizontal, 16)
                    .frame(maxHeight: .infinity)
                    Link(destination: WidgetLink.radio(seedId: now.id, name: now.title).url) {
                        HStack(spacing: 10) {
                            Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 15, weight: .semibold))
                            Text("Open song radio").font(.system(size: 15.5, weight: .semibold)).tracking(-0.2)
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 47)
                        .background(.black.opacity(0.13))
                    }
                }
            } else {
                EmptyState()
            }
        }
        .widgetURL(WidgetLink.nowPlaying.url)
        .containerBackground(Look.tint(now), for: .widget)
    }
}
