import Foundation

/// The pure parts of the Listening history page (web components/History.jsx, UI.md 7.5).
enum AccountHistoryLogic {
    /// History.jsx `RANGES`: key, chip label key, description suffix key ("" for lifetime).
    enum Range: String, CaseIterable, Identifiable, Sendable {
        case today, week, fourWeeks = "4w", sixMonths = "6m", year, all

        var id: String { rawValue }

        /// The chip label. The year chip is the current year number, not translated.
        func label(now: Date = Date(), calendar: Calendar = .current) -> String {
            switch self {
            case .today: L("today")
            case .week: L("this week")
            case .fourWeeks: L("4 weeks")
            case .sixMonths: L("6 months")
            case .year: String(calendar.component(.year, from: now))
            case .all: L("lifetime")
            }
        }

        /// The description suffix key (nil for lifetime: the bare sentence is used).
        var suffix: String? {
            switch self {
            case .today: "from today"
            case .week: "from this week"
            case .fourWeeks: "from the past 4 weeks"
            case .sixMonths: "from the past 6 months"
            case .year: "from this year"
            case .all: nil
            }
        }

        static let storageKey = "conduit.histRange2"
        static let `default` = Range.fourWeeks
    }

    /// A section description: `t(withRange, {range: t(suffix)})`, or the bare sentence for lifetime.
    static func description(_ withRange: String, bare: String, range: Range) -> String {
        guard let s = range.suffix else { return L(bare) }
        return L(withRange, ["range": L(s)])
    }

    /// Locale number grouping (`toLocaleString(language)`).
    static func number(_ n: Double, locale: Locale) -> String {
        let f = NumberFormatter()
        f.locale = locale
        f.numberStyle = .decimal
        f.maximumFractionDigits = 2
        return f.string(from: NSNumber(value: n)) ?? String(n)
    }
    static func number(_ n: Int, locale: Locale) -> String { number(Double(n), locale: locale) }

    static func streams(_ n: Int, locale: Locale) -> String {
        n == 1 ? L("1 stream") : L("{n} streams", ["n": number(n, locale: locale)])
    }
    /// `t('{n} minutes', {n: floor(secs / 60)})`.
    static func minutes(seconds: Double, locale: Locale) -> String {
        L("{n} minutes", ["n": number(Int((seconds / 60).rounded(.down)), locale: locale)])
    }
    /// History.jsx `hm`: "1h 5m" / "42m".
    static func hm(_ secs: Double) -> String {
        let h = Int(secs / 3600)
        let m = Int((secs.truncatingRemainder(dividingBy: 3600) / 60).rounded())
        return h > 0 ? "\(h)h \(m)m" : "\(m)m"
    }

    // MARK: stat cards

    /// History.jsx `Delta`: nil = hidden; else the rounded percentage change.
    static func delta(now: Int?, before: Int?) -> Int? {
        guard let before else { return nil }
        let now = now ?? 0
        if before == 0 && now == 0 { return nil }
        if before == 0 { return 100 }
        return Int((Double(now - before) / Double(before) * 100).rounded())
    }

    struct StatCard: Equatable {
        var label: String
        var value: Int
        var before: Int?
    }

    /// The seven cards, in order (History.jsx:377-394). `label` is the i18n key.
    static func cards(_ s: HistoryStats) -> [StatCard] {
        let n = s.numbers, p = s.prev
        let hours = { (m: Int?) in Int((Double(m ?? 0) / 60).rounded()) }
        return [
            StatCard(label: "streams", value: n.streams ?? 0, before: p?.streams),
            StatCard(label: "minutes streamed", value: n.minutes ?? 0, before: p?.minutes),
            StatCard(label: "hours streamed", value: hours(n.minutes), before: p.map { hours($0.minutes) }),
            StatCard(label: "days streamed", value: n.daysStreamed ?? 0, before: p?.daysStreamed),
            StatCard(label: "different tracks", value: n.uniqueTracks ?? 0, before: p?.uniqueTracks),
            StatCard(label: "different artists", value: n.uniqueArtists ?? 0, before: p?.uniqueArtists),
            StatCard(label: "different albums", value: n.uniqueAlbums ?? 0, before: p?.uniqueAlbums),
        ]
    }

    /// Averages per day with any stream (days with a count; at least 1).
    static func averages(_ s: HistoryStats) -> (streams: Int, minutes: Int) {
        let days = max(1, s.perDay.filter { $0.count > 0 }.count)
        return (Int((Double(s.numbers.streams ?? 0) / Double(days)).rounded()),
                Int((Double(s.numbers.minutes ?? 0) / Double(days)).rounded()))
    }

    // MARK: charts

    struct Point: Equatable {
        var label: String
        var streams: Double
        var minutes: Double
    }

    enum Bucket: Equatable { case day, week, month }

    /// Days up to 60, ISO weeks up to 200, else months.
    static func bucketMode(count: Int) -> Bucket { count > 200 ? .month : count > 60 ? .week : .day }

    private static func parseDay(_ iso: String, calendar: Calendar) -> Date? {
        let parts = iso.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// History.jsx `bucket`: per day, per week (Monday, labelled "MMM d") or per month ("MMM yy").
    static func buckets(_ days: [HistoryStats.Day], locale: Locale, calendar: Calendar = .current) -> [Point] {
        let mode = bucketMode(count: days.count)
        let short = DateFormatter(); short.locale = locale; short.calendar = calendar; short.timeZone = calendar.timeZone
        short.setLocalizedDateFormatFromTemplate("MMMd")
        let month = DateFormatter(); month.locale = locale; month.calendar = calendar; month.timeZone = calendar.timeZone
        month.setLocalizedDateFormatFromTemplate("MMMyy")
        if mode == .day {
            return days.map { d in
                Point(label: parseDay(d.day, calendar: calendar).map { short.string(from: $0) } ?? d.day,
                      streams: Double(d.count), minutes: Double(d.minutes))
            }
        }
        var order: [String] = []
        var acc: [String: Point] = [:]
        for d in days {
            guard let dt = parseDay(d.day, calendar: calendar) else { continue }
            let key: String, label: String
            if mode == .month {
                let c = calendar.dateComponents([.year, .month], from: dt)
                key = String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
                label = month.string(from: dt)
            } else {
                // JS: (getDay() + 6) % 7 days back = the Monday of that week.
                let weekday = calendar.component(.weekday, from: dt) // 1 = Sunday
                let back = (weekday - 1 + 6) % 7
                let monday = calendar.date(byAdding: .day, value: -back, to: dt) ?? dt
                let c = calendar.dateComponents([.year, .month, .day], from: monday)
                key = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
                label = short.string(from: monday)
            }
            if acc[key] == nil { order.append(key); acc[key] = Point(label: label, streams: 0, minutes: 0) }
            acc[key]!.streams += Double(d.count)
            acc[key]!.minutes += Double(d.minutes)
        }
        return order.map { acc[$0]! }
    }

    /// Running sums ("Cumulative").
    static func cumulative(_ pts: [Point]) -> [Point] {
        var a = 0.0, b = 0.0
        return pts.map { p in a += p.streams; b += p.minutes; return Point(label: p.label, streams: a, minutes: b) }
    }

    /// History.jsx `ticksFor`: 0 to a rounded max in about 3 steps of 1/2/2.5/5/10 x 10^k.
    static func ticks(max: Double) -> [Double] {
        guard max > 0 else { return [0, 1] }
        let raw = max / 3
        let mag = pow(10, floor(log10(raw)))
        let step = [1, 2, 2.5, 5, 10].map { $0 * mag }.first { $0 >= raw } ?? mag * 10
        var out: [Double] = []
        var v = 0.0
        while v <= max + step * 0.999 {
            out.append((v * 100).rounded() / 100)
            v += step
        }
        return out
    }

    /// Indices that get an x label: every `ceil(n/8)`-th, plus the last; none for a single point.
    static func xLabelIndices(_ n: Int) -> [Int] {
        guard n > 1 else { return [] }
        let every = max(1, Int((Double(n) / 8).rounded(.up)))
        return (0..<n).filter { $0 % every == 0 || $0 == n - 1 }
    }

    /// The point under a finger at `x` in a plot running `plotMinX...plotMaxX` (clamped).
    static func scrubIndex(x: Double, plotMinX: Double, plotMaxX: Double, count n: Int) -> Int? {
        guard n > 0 else { return nil }
        guard n > 1, plotMaxX > plotMinX else { return 0 }
        let i = Int(((x - plotMinX) / (plotMaxX - plotMinX) * Double(n - 1)).rounded())
        return min(n - 1, max(0, i))
    }

    // MARK: clocks

    /// Wedge radius fraction (0...1) per hour: value / max.
    static func clockFractions(_ values: [Double]) -> [Double] {
        let m = Swift.max(1, values.max() ?? 0)
        return values.map { Swift.max(0, $0 / m) }
    }

    /// "13:00 - 14:00".
    static func hourLabel(_ i: Int) -> String {
        String(format: "%02d:00 - %02d:00", i, (i + 1) % 24)
    }

    // MARK: recent streams

    /// History.jsx `fromNow`, seconds ago.
    static func fromNow(seconds s: Double) -> String {
        let s = Swift.max(0, s.rounded(.down))
        if s < 45 { return L("a few seconds ago") }
        if s < 90 { return L("a minute ago") }
        if s < 2700 { return L("{n} minutes ago", ["n": Int((s / 60).rounded())]) }
        if s < 5400 { return L("an hour ago") }
        if s < 79200 { return L("{n} hours ago", ["n": Int((s / 3600).rounded())]) }
        if s < 129600 { return L("a day ago") }
        if s < 2246400 { return L("{n} days ago", ["n": Int((s / 86400).rounded())]) }
        if s < 3888000 { return L("a month ago") }
        if s < 27993600 { return L("{n} months ago", ["n": Int((s / 2592000).rounded())]) }
        if s < 47260800 { return L("a year ago") }
        let y = Int((s / 31536000).rounded())
        return y == 1 ? L("1 year ago") : L("{n} years ago", ["n": y])
    }

    struct DayGroup<Row> {
        var day: String
        var rows: [Row]
    }

    /// Consecutive rows on the same calendar day ("MMMM d, yyyy" in the locale), newest first as given.
    static func groupByDay<Row>(_ rows: [Row], at: (Row) -> Date, locale: Locale, calendar: Calendar = .current) -> [DayGroup<Row>] {
        let f = DateFormatter(); f.locale = locale; f.calendar = calendar; f.timeZone = calendar.timeZone
        f.setLocalizedDateFormatFromTemplate("MMMMdyyyy")
        var out: [DayGroup<Row>] = []
        for r in rows {
            let day = f.string(from: at(r))
            if out.last?.day == day { out[out.count - 1].rows.append(r) } else { out.append(DayGroup(day: day, rows: [r])) }
        }
        return out
    }

    /// Second line of a recent row: artist • album (the server has no Spotify source flag).
    static func recentSubtitle(_ t: Track) -> String {
        [t.artist, t.album].filter { !$0.isEmpty }.joined(separator: " • ")
    }
}
