import SwiftUI

/// What the Generate dialog was opened for: a new playlist, or new songs in an existing one
/// (`regenerate` in GeneratePlaylist.jsx: the same box with what was asked last time).
struct GenerateRequest: Identifiable {
    let id = UUID()
    var playlistId: String?
    var prompt: String = ""
    var regenerate: Bool { playlistId != nil }
}

/// The dialog's words and numbers (GeneratePlaylist.jsx, App.jsx onDone), apart from the view.
enum GenerateLogic {
    static let ideas = [
        "Late night drive, R&B and slow rap",
        "Upbeat songs for the gym",
        "Like my most played lately, but songs I have not heard much",
        "Chill Sunday morning, acoustic and soft",
        "2010s pop throwbacks",
    ]

    /// `timeLeft`: the server's estimate minus the time since it arrived, in 5 s steps.
    static func timeLeft(leftMs: Double, elapsedMs: Double) -> String {
        let ms = leftMs - elapsedMs
        if ms < 5000 { return L("Almost done") }
        let s = Int((ms / 5000).rounded(.up)) * 5
        if s < 60 { return L("About {s} s left", ["s": s]) }
        return s % 60 != 0 ? L("About {m} min {s} s left", ["m": s / 60, "s": s % 60]) : L("About {m} min left", ["m": s / 60])
    }

    /// Bar fill, 0...1: never thinner than 3 %.
    static func fill(_ progress: Double?) -> Double { max(0.03, min(1, progress ?? 0)) }

    /// The words after a stage's label: what "find" found once done, else the active stage's detail.
    static func stageDetail(_ st: GenerateJob.Stage, info: GenerateJob.Info) -> String? {
        if st.key == "find", st.state == "done", let n = info.found, n > 0 {
            return L("{n} songs, {fresh} you have not played", ["n": n, "fresh": info.foundNew ?? 0])
        }
        if st.state == "active", let d = st.detail, !d.isEmpty { return d }
        return nil
    }

    /// "1 more song is downloading…", or nothing.
    static func more(_ requested: Int) -> String {
        requested <= 0 ? "" : requested == 1 ? L("1 more song is downloading and will be added.") : L("{n} more songs are downloading and will be added.", ["n": requested])
    }

    enum Outcome: Equatable { case open(String), toast(String), openAndToast(String, String) }

    /// What happens when the job ends (App.jsx onDone): open the playlist, say so, or both.
    static func outcome(_ r: GenerateJob.Result, hidden: Bool) -> Outcome {
        let more = more(r.requested ?? 0)
        if r.regenerated == true {
            let text = more.isEmpty ? L("{name} regenerated", ["name": r.name]) : L("{name} regenerated. {more}", ["name": r.name, "more": more])
            return hidden ? .toast(text) : .openAndToast(r.playlistId, text)
        }
        if hidden {
            return .toast(more.isEmpty ? L("{name} is ready in Your Library.", ["name": r.name]) : L("{name} is ready in Your Library. {more}", ["name": r.name, "more": more]))
        }
        return more.isEmpty ? .open(r.playlistId) : .toast(more)
    }

    /// The server's words without a leading status code ("503: …").
    static func errorText(_ error: Error) -> String {
        let m = error.localizedDescription
        return m.replacingOccurrences(of: #"^\d+: "#, with: "", options: .regularExpression)
    }
}

/// One generation, followed to its end whether or not the dialog is still up ("Hide").
@MainActor @Observable
final class GenerateRun {
    struct Busy { var step: String; var progress: Double?; var info: GenerateJob.Info?; var got: Date }

    private(set) var busy: Busy?
    private(set) var error: String?
    /// Is the dialog still open? After "Hide" the finished playlist is announced, not opened.
    @ObservationIgnored var open = true
    /// Poll interval; tests shorten it.
    @ObservationIgnored var interval: TimeInterval = 1

    /// `waitJob`: poll every second until the job ends. `finish` gets the result and whether the
    /// dialog was hidden meanwhile; a failure with the dialog open stays in it to be retried.
    func start(api: APIClient, prompt: String, playlistId: String?, finish: @escaping (GenerateJob.Result?, _ hidden: Bool, _ error: String?) -> Void) {
        guard busy == nil else { return }
        error = nil
        busy = Busy(step: L("Starting"), progress: nil, info: nil, got: Date())
        Task {
            do {
                var j = try await api.generatePlaylist(prompt: prompt, playlistId: playlistId)
                while j.state == "running" || j.state == "queued" {
                    if open { busy = Busy(step: j.step ?? L("Starting"), progress: j.progress, info: j.info, got: Date()) }
                    try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                    j = try await Self.poll(api, j.id)
                }
                if j.state == "error" { throw APIError.http(0, j.error ?? "failed") }
                guard let r = j.result else { throw APIError.http(0, "failed") }
                busy = nil
                finish(r, !open, nil)
            } catch {
                let msg = GenerateLogic.errorText(error)
                busy = nil
                if open { self.error = msg } else { finish(nil, true, msg) }
            }
        }
    }

    /// A dropped poll is asked again (the web's `retries: 2`); the job itself is unharmed.
    private static func poll(_ api: APIClient, _ id: String) async throws -> GenerateJob {
        var last: Error?
        for attempt in 0..<3 {
            do { return try await api.job(id) } catch {
                last = error
                if case APIError.http = error { throw error }
                if attempt < 2 { try await Task.sleep(nanoseconds: 400_000_000) }
            }
        }
        throw last ?? APIError.offline
    }
}

/// Generated playlist (AI) dialog (UI.md 6.4).
struct GeneratePlaylistDialog: View {
    let request: GenerateRequest
    let api: APIClient
    var close: (_ then: (() -> Void)?) -> Void
    /// The playlist to show (new, or regenerated while the dialog was open).
    var onOpen: (String) -> Void

    @Environment(\.theme) private var theme
    @State private var prompt: String
    @State private var status: AIStatus?
    @State private var run = GenerateRun()
    @State private var appeared = false
    @FocusState private var focused: Bool

    init(request: GenerateRequest, api: APIClient, close: @escaping (_ then: (() -> Void)?) -> Void, onOpen: @escaping (String) -> Void) {
        self.request = request; self.api = api; self.close = close; self.onOpen = onOpen
        _prompt = State(initialValue: request.prompt)
    }

    private var trimmed: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var off: Bool { status.map { !$0.ok } ?? false }
    private var busy: Bool { run.busy != nil }

    var body: some View {
        GeometryReader { g in
            ZStack {
                Theme.Fixed.sheetScrim.opacity(appeared ? 1 : 0).ignoresSafeArea()
                    .onTapGesture { if !busy { close(nil) } }
                VStack(alignment: .leading, spacing: 16) {
                    Text(request.regenerate ? L("Regenerate playlist") : L("Generated playlist")).textStyle(.dialogTitle).foregroundStyle(theme.fg)
                    if off {
                        note(status?.reason ?? L("Generated playlists are not available on this server."))
                    } else {
                        if !busy {
                            note(request.regenerate
                                 ? L("Change the request or keep it. The songs in this playlist are replaced; a name or cover you gave it stays.")
                                 : L("Describe what you want. The brain finds 25 songs in your library that sound like it: 20 you have not played yet, 5 you know."))
                        }
                        field
                        if !busy && prompt.isEmpty { ideas }
                        if let b = run.busy { GenerateProgress(busy: b) }
                        if let e = run.error { Text(e).font(.system(size: 14)).foregroundStyle(theme.danger) }
                    }
                    HStack(spacing: 8) {
                        Spacer()
                        SecondaryButton(busy ? L("Hide") : L("Cancel")) { close(nil) }
                        if !off {
                            PrimaryButton(request.regenerate ? L("Regenerate") : L("Generate"), action: submit)
                                .disabled(trimmed.isEmpty || busy || status == nil)
                        }
                    }
                }
                .padding(24)
                .frame(width: min(520, g.size.width - 32))
                .background(theme.bgElevatedHi, in: RoundedRectangle(cornerRadius: Radius.dialog))
                .shadow(color: .black.opacity(0.3), radius: 12, y: 16)
                .opacity(appeared ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { withAnimation(Motion.scrim) { appeared = true } }
        .onDisappear { run.open = false }
        .task {
            do { status = try await api.aiStatus() } catch { status = AIStatus(ok: false, reason: L("Could not reach the server.")) }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).lineSpacing(14 * 0.45).foregroundStyle(theme.fgSub)
            .fixedSize(horizontal: false, vertical: true).padding(.top, -6)
    }

    private var field: some View {
        TextField("", text: $prompt, prompt: Text(L("e.g. rainy day indie, a bit melancholy")), axis: .vertical)
            .lineLimit(3...8)
            .font(.system(size: 16)).foregroundStyle(theme.fg)
            .padding(.vertical, 12).padding(.horizontal, 14)
            .frame(minHeight: 84, alignment: .topLeading)
            .background(theme.field, in: RoundedRectangle(cornerRadius: Radius.art))
            .overlay(RoundedRectangle(cornerRadius: Radius.art).strokeBorder(focused ? theme.fg : Theme.Fixed.textFieldBorder, lineWidth: 1))
            .focused($focused)
            .submitLabel(.done)
            .disabled(busy)
            .opacity(busy ? 0.6 : 1)
            // Return submits (the web's Enter); the newline it typed is taken back out.
            .onChange(of: prompt) { _, v in
                if v.count > 1000 { prompt = String(v.prefix(1000)); return }
                if v.hasSuffix("\n") { prompt = String(v.dropLast()); submit() }
            }
            .onAppear { DispatchQueue.main.async { focused = true } }
    }

    private var ideas: some View {
        GenerateFlow(spacing: 8) {
            ForEach(GenerateLogic.ideas, id: \.self) { idea in
                Chip(L(idea), small: true) { prompt = L(idea) }
            }
        }
    }

    private func submit() {
        let p = trimmed
        guard !p.isEmpty, !busy, status?.ok == true else { return }
        focused = false
        let playlistId = request.playlistId
        let open = onOpen, shut = close
        run.start(api: api, prompt: p, playlistId: playlistId) { result, hidden, error in
            let store = LibraryStore.shared
            if let error { ToastCenter.shared.show(L("Could not generate the playlist: {error}", ["error": error]), seconds: 5); return }
            guard let result else { return }
            Task {
                await store.refreshPlaylists()
                store.onLibraryChanged?()
                // A page already showing this playlist takes the new songs.
                store.touch(result.playlistId)
                switch GenerateLogic.outcome(result, hidden: hidden) {
                case .open(let id): shut { open(id) }
                case .toast(let text):
                    if !hidden { shut(nil) }
                    ToastCenter.shared.show(text, seconds: 5)
                case .openAndToast(let id, let text): shut { open(id) }; ToastCenter.shared.show(text, seconds: 5)
                }
            }
        }
    }
}

/// The busy part: title, vibe, bar, time left, stages.
private struct GenerateProgress: View {
    let busy: GenerateRun.Busy
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let t = busy.info?.title, !t.isEmpty { Text(t).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg) }
            if let v = busy.info?.vibe, !v.isEmpty {
                Text(v).font(.system(size: 13)).lineSpacing(13 * 0.45).foregroundStyle(theme.fgSub).fixedSize(horizontal: false, vertical: true)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(theme.fg.opacity(0.2))
                    Capsule().fill(theme.accent).frame(width: g.size.width * GenerateLogic.fill(busy.progress))
                        .animation(.easeInOut(duration: 0.6), value: busy.progress)
                }
            }
            .frame(height: 4)
            .accessibilityElement().accessibilityValue("\(Int((busy.progress ?? 0) * 100)) %")
            TimelineView(.periodic(from: .now, by: 0.5)) { tl in
                Text(left(at: tl.date)).font(.system(size: 13)).foregroundStyle(theme.fgSub)
            }
            if let info = busy.info, let stages = info.stages {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(stages, id: \.key) { st in stage(st, info) }
                }
            }
        }
    }

    private func left(at now: Date) -> String {
        guard let info = busy.info, let ms = info.leftMs else { return busy.step }
        return GenerateLogic.timeLeft(leftMs: ms, elapsedMs: now.timeIntervalSince(busy.got) * 1000)
    }

    private func stage(_ st: GenerateJob.Stage, _ info: GenerateJob.Info) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                switch st.state {
                case "done": IconView(.check, size: 14).foregroundStyle(theme.accent)
                case "active": GenerateSpinner()
                default: Circle().fill(theme.fgFaint).frame(width: 6, height: 6)
                }
            }
            .frame(width: 16, height: 16)
            .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 3 }
            (Text(st.label).font(.system(size: 14, weight: st.state == "active" ? .semibold : .regular))
                .foregroundColor(st.state == "active" ? theme.fg : st.state == "done" ? theme.fgSub : theme.fgFaint)
             + Text(GenerateLogic.stageDetail(st, info: info).map { " · \($0)" } ?? "").font(.system(size: 14)).foregroundColor(theme.fgSub))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// 16 pt ring, the top segment in the accent, once round every 0.8 s.
private struct GenerateSpinner: View {
    @Environment(\.theme) private var theme
    @State private var turning = false
    var body: some View {
        ZStack {
            Circle().stroke(theme.fg.opacity(0.25), lineWidth: 2)
            Circle().trim(from: 0, to: 0.25).stroke(theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(turning ? 360 : 0))
                .animation(.linear(duration: 0.8).repeatForever(autoreverses: false), value: turning)
        }
        .frame(width: 14, height: 14)
        .onAppear { turning = true }
    }
}

/// Pills that wrap onto as many lines as they need.
private struct GenerateFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = place(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: proposal.width ?? rows.width, height: rows.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (i, p) in place(subviews, width: bounds.width).points.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: ProposedViewSize(width: min(bounds.width, subviews[i].sizeThatFits(.unspecified).width), height: nil))
        }
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> (points: [CGPoint], width: CGFloat, height: CGFloat) {
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        var points: [CGPoint] = []
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            let w = min(s.width, width)
            if x > 0 && x + w > width { x = 0; y += line + spacing; line = 0 }
            points.append(CGPoint(x: x, y: y))
            x += w + spacing; line = max(line, s.height); widest = max(widest, x - spacing)
        }
        return (points, widest, y + line)
    }
}

extension View {
    /// Present the Generate dialog for `request`; `onOpen` shows the playlist it made.
    func generateDialog(_ request: Binding<GenerateRequest?>, api: APIClient, onOpen: @escaping (String) -> Void) -> some View {
        overlayCover(item: request) { r, close in GeneratePlaylistDialog(request: r, api: api, close: close, onOpen: onOpen) }
    }
}
