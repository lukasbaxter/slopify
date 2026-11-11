import Foundation

/// Words and grouping of the Downloads page (web components/Downloads.jsx, UI.md 5.9).
/// Times are server milliseconds; every function takes `now` (ms) so it is testable.
enum AccountDownloadsLogic {
    /// Downloads.jsx `SECTIONS`: state, heading key, summary key.
    struct Section: Equatable {
        var state: String
        var heading: String
        var count: String
    }

    static let sections: [Section] = [
        Section(state: "downloading", heading: "Downloading", count: "{n} downloading"),
        Section(state: "adding", heading: "Adding to library", count: "{n} adding to library"),
        Section(state: "stuck", heading: "Stuck", count: "{n} stuck"),
        Section(state: "queued", heading: "Waiting in line", count: "{n} waiting in line"),
        Section(state: "failed", heading: "Failed", count: "{n} failed"),
        Section(state: "done", heading: "Done", count: "{n} done"),
    ]

    /// `Done` and `Failed` show at most 30 rows.
    static func shown(_ items: [DownloadsPage.Item], state: String) -> [DownloadsPage.Item] {
        let list = items.filter { $0.state == state }
        return state == "done" || state == "failed" ? Array(list.prefix(30)) : list
    }

    /// Summary entries for non-empty states: (state, text).
    static func summary(_ items: [DownloadsPage.Item]) -> [(state: String, text: String)] {
        sections.compactMap { s in
            let n = items.filter { $0.state == s.state }.count
            return n > 0 ? (s.state, L(s.count, ["n": n])) : nil
        }
    }

    /// Drop a leading `NNN: ` from an error message.
    static func cleanError(_ s: String) -> String {
        s.replacingOccurrences(of: #"^\d+: "#, with: "", options: .regularExpression)
    }

    // MARK: time words

    static func ago(_ at: Double?, now: Double) -> String {
        guard let at, at > 0 else { return "" }
        let s = max(0, ((now - at) / 1000).rounded())
        if s < 60 { return L("just now") }
        let m = Int((s / 60).rounded()); if m < 60 { return L("{n} min ago", ["n": m]) }
        let h = Int((Double(m) / 60).rounded()); if h < 24 { return L("{n} h ago", ["n": h]) }
        let d = Int((Double(h) / 24).rounded())
        return d == 1 ? L("1 day ago") : L("{n} days ago", ["n": d])
    }

    static func duration(ms: Double) -> String {
        let m = max(1, Int((ms / 60000).rounded()))
        return m < 60 ? L("{n} min", ["n": m]) : L("{n} h", ["n": Int((Double(m) / 60).rounded())])
    }

    static func inTime(_ at: Double, now: Double) -> String {
        let s = Int(((at - now) / 1000).rounded())
        if s <= 5 { return L("any moment now") }
        if s < 90 { return L("in {n} s", ["n": s]) }
        return L("in {time}", ["time": duration(ms: Double(s) * 1000)])
    }

    // MARK: lines

    static func watcherLine(_ w: DownloadsPage.Watcher?, now: Double) -> String? {
        guard let w else { return nil }
        let when: String
        if w.checking == true { when = L("checking the wanted list now") }
        else {
            var parts: [String] = []
            if let l = w.lastCheck, l > 0 { parts.append(L("last checked {when}", ["when": ago(l, now: now)])) }
            if let n = w.next, n > 0 { parts.append(L("next check {when}", ["when": inTime(n, now: now)])) }
            when = parts.joined(separator: " • ")
        }
        var load = ""
        if let wanted = w.wanted {
            if let per = w.perCheck, per > 0, wanted > per { load = L("{n} albums wanted, {per} searched per check", ["n": wanted, "per": per]) }
            else if wanted == 1 { load = L("1 album wanted") }
            else { load = L("{n} albums wanted", ["n": wanted]) }
        }
        return L("Soulseek downloader: {status}", ["status": [when, load].filter { !$0.isEmpty }.joined(separator: " • ")])
    }

    /// Downloads.jsx `waitingText`.
    static func waitingText(_ d: DownloadsPage.Item, watcher w: DownloadsPage.Watcher?, now: Double) -> String {
        var next = ""
        if let w {
            if w.checking == true { next = L("checking now") }
            else if let n = w.next, n > 0 { next = L("next try {when}", ["when": inTime(n, now: now)]) }
        }
        if let s = d.search {
            if s.outcome == "searching" { return L("Searching Soulseek for it now…") }
            let when = ago(s.at, now: now)
            let what: String
            switch s.outcome {
            case "noresults": what = L("Searched Soulseek {when}: nobody is sharing it", ["when": when])
            case "nomatch":
                what = s.results == 1
                    ? L("Searched Soulseek {when}: 1 result, none a complete match for this release", ["when": when])
                    : L("Searched Soulseek {when}: {n} results, none a complete match for this release", ["when": when, "n": s.results ?? 0])
            case "refused": what = L("Found on Soulseek {when}, but nobody sharing it would send it (offline or their queue is full)", ["when": when])
            case "matched": what = L("Found on Soulseek {when}, the download is starting", ["when": when])
            default: what = L("Searched Soulseek {when}", ["when": when])
            }
            return s.outcome == "matched" ? what : [what, next].filter { !$0.isEmpty }.joined(separator: " • ")
        }
        guard let w else {
            let req = d.requested.map { " • " + L("requested {when}", ["when": ago($0, now: now)]) } ?? ""
            return L("Waiting for the downloader to pick it up") + req
        }
        let when: String
        if w.checking == true { when = L("running now") }
        else if let n = w.next, n > 0 { when = inTime(n, now: now) }
        else { when = L("soon") }
        if let per = w.perCheck, per > 0, let wanted = w.wanted, wanted > per {
            return L("Not searched yet • first search at the next check, {when} ({n} albums wait, {per} are searched per check, so it can take a few)", ["when": when, "n": wanted, "per": per])
        }
        return L("Not searched yet • first search at the next check, {when}", ["when": when])
    }

    /// `{done} of {total} songs` / `{done} of 1 song`.
    static func ofSongs(_ d: DownloadsPage.Item) -> String {
        d.total == 1 ? L("{done} of 1 song", ["done": d.done]) : L("{done} of {total} songs", ["done": d.done, "total": d.total])
    }

    /// The status line text and whether it is a warning (red).
    static func statusLine(_ d: DownloadsPage.Item, watcher: DownloadsPage.Watcher?, now: Double) -> (text: String, warn: Bool) {
        switch d.state {
        case "downloading":
            if d.via == "torrent" { return (L("Torrent") + " • " + (d.detail ?? ""), false) }
            let started = d.started.map { " • " + L("started {when}", ["when": ago($0, now: now)]) } ?? ""
            return (ofSongs(d) + started, false)
        case "stuck":
            let head: String
            if d.search != nil { head = waitingText(d, watcher: watcher, now: now) }
            else if let r = d.reason, !r.isEmpty { head = r }
            else { head = L("No progress for {time}", ["time": duration(ms: now - (d.progressAt ?? d.started ?? now))]) }
            return (head + " • " + ofSongs(d), true)
        case "queued":
            return (waitingText(d, watcher: watcher, now: now), false)
        case "failed":
            let r = (d.reason?.isEmpty == false ? d.reason! : L("Failed"))
            return (r + (d.finished.map { " • " + ago($0, now: now) } ?? ""), true)
        case "adding":
            return (L("Downloaded • adding to your library…"), false)
        case "done":
            let fin = d.finished.map { " • " + ago($0, now: now) } ?? ""
            if d.libraryAlbumId != nil {
                return ((d.done == 1 ? L("1 song added") : L("{n} songs added", ["n": d.done])) + fin, false)
            }
            return (L("Downloaded, but not found in your library") + fin, true)
        default:
            return ("", false)
        }
    }

    /// Progress bar fill (0...1), or nil when the state has no bar.
    static func progress(_ d: DownloadsPage.Item) -> Double? {
        switch d.state {
        case "done", "adding": return 1
        case "downloading", "stuck":
            let pct = d.total > 0 ? min(100, (Double(d.done) / Double(d.total) * 100).rounded()) : 0
            return max(pct, d.state == "downloading" ? 3 : 0) / 100
        default: return nil
        }
    }

    enum Action: Equatable { case play, retry }

    static func action(_ d: DownloadsPage.Item) -> Action? {
        if d.state == "done" && d.libraryAlbumId != nil { return .play }
        if d.state == "failed" || d.state == "stuck" { return .retry }
        return nil
    }

    /// `{artist} • {type} • {year}`.
    static func meta(_ d: DownloadsPage.Item) -> String {
        [d.artist, d.type, d.year].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " • ")
    }
}
