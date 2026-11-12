import SwiftUI

/// Phone shell (UI.md 2.3): three tab stacks, floating mini player above a custom tab bar,
/// now playing / queue as full-screen layers, the account drawer and the device sheet.
struct MainShell: View {
    @Environment(Navigator.self) private var nav
    @Namespace private var homeZoom
    @Environment(Player.self) private var player

    var body: some View {
        @Bindable var nav = nav
        ZStack(alignment: .bottom) {
            ZStack {
                tabStack(.home) { HomeView() }
                tabStack(.search) { SearchView() }
                tabStack(.library) { LibraryView() }
            }
            VStack(spacing: 0) {
                MiniPlayer()
                ShellTabBar()
            }
        }
        .ignoresSafeArea(.keyboard)
        .fullScreenCover(isPresented: $nav.nowPlayingOpen) {
            NowPlayingView()
                .fullScreenCover(isPresented: $nav.queueOpen) { QueueView() }
        }
        .overlay { if nav.drawerOpen { AccountDrawer().transition(.identity) } }
        .onChange(of: nav.nowPlayingOpen, initial: true) { _, open in
            ToastCenter.shared.layout = open ? .nowPlaying : .shell(miniPlayer: true)
        }
    }

    @ViewBuilder
    private func tabStack<Root: View>(_ t: Navigator.Tab, @ViewBuilder root: () -> Root) -> some View {
        NavigationStack(path: nav.binding(t)) {
            root()
                .background {
                    SwipeBackInstaller(isActiveTab: { [weak nav] in nav?.tab == t },
                                       isCovered: { [weak nav] in nav.map { $0.drawerOpen || $0.nowPlayingOpen } ?? true },
                                       openDrawer: { [weak nav] in nav?.drawerOpen = true },
                                       goBack: { [weak nav] in nav?.pop(t) })
                }
                .navigationDestination(for: Route.self) { RouteDestination(route: $0) }
                .navigationDestination(for: HomeRoute.self) {
                    RouteDestination(route: $0.route).navigationTransition(.zoom(sourceID: $0, in: homeZoom))
                }
        }
        .environment(\.homeZoom, t == .home ? homeZoom : nil)
        .opacity(nav.tab == t ? 1 : 0)
        .allowsHitTesting(nav.tab == t)
        .accessibilityHidden(nav.tab != t)
    }
}

/// UI.md 2.4: three equal columns, 24 pt glyph (outline off, filled on), 10/500 label,
/// `--fg-sub` off / `--fg` on, pressed 0.6, solid `--page` background.
struct ShellTabBar: View {
    @Environment(Navigator.self) private var nav
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            item(.home, "Home", .homeTab, .homeTabFilled)
            item(.search, "Search", .searchTab, .searchTabFilled)
            item(.library, "Your Library", .libraryTab, .libraryTabFilled)
        }
        .frame(height: Shell.tabBar, alignment: .top)
        .padding(.top, 6).padding(.bottom, 4)
        .background(theme.page.ignoresSafeArea(edges: .bottom))
    }

    private func item(_ t: Navigator.Tab, _ key: String, _ off: Icon, _ on: Icon) -> some View {
        let lit = nav.tab == t
        return Button { nav.select(t) } label: {
            VStack(spacing: 2) {
                IconView(lit ? on : off, size: 24)
                Text(L(key)).textStyle(.tabLabel)
            }
            .padding(.vertical, 2)
            .foregroundStyle(lit ? theme.fg : theme.fgSub)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
    }
}
