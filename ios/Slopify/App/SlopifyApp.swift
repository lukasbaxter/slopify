import SwiftUI

@main
struct SlopifyApp: App {
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.account)
                .environment(app.session)
                .environment(app.player)
                .environment(app.likes)
                .environment(app.library)
                .environment(app.offline)
                .environment(app.nav)
                .environment(\.apiClient, app.account.api)
                .themed(app.themeStore)
                .onChange(of: phase) { _, p in if p == .active { Task { await app.start() } } }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(Account.self) private var account

    var body: some View {
        Group {
            switch account.state {
            case .signedIn: MainShell().task { await app.start() }
            case .signedOut, .passwordChange: SignInFlow()
            }
        }
        .onChange(of: account.state) { old, new in
            if new == .signedOut { app.stop() }
        }
    }
}
