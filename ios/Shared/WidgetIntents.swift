import AppIntents

/// What the widget's play / pause button does. An `AudioPlaybackIntent` is run by the system
/// inside the app (started in the background if it has to be), never in the widget process,
/// so the app sets `WidgetBridge.toggle` and the extension leaves it empty.
struct TogglePlaybackIntent: AudioPlaybackIntent {
    static let title: LocalizedStringResource = "Play or pause"
    static let isDiscoverable = false
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult {
        // A cold start: the app model is built on the main actor right at launch; give it a moment.
        for _ in 0..<20 {
            if await WidgetBridge.toggle != nil { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await WidgetBridge.toggle?()
        return .result()
    }
}

@MainActor
enum WidgetBridge {
    static var toggle: (() async -> Void)?
}
