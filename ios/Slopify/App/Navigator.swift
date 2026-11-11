import SwiftUI

/// Tabs, per-tab stacks and the full-screen layers (DECISIONS.md 7).
@MainActor @Observable
final class Navigator {
    enum Tab: Hashable { case home, search, library }

    var tab: Tab = .home
    var paths: [Tab: NavigationPath] = [.home: NavigationPath(), .search: NavigationPath(), .library: NavigationPath()]
    var nowPlayingOpen = false
    var queueOpen = false
    var drawerOpen = false
    var deviceSheetOpen = false
    /// Bumped when the lit tab is tapped on its root: the root scrolls to top.
    private(set) var scrollToTop: [Tab: Int] = [:]

    func push(_ r: Route) { paths[tab, default: NavigationPath()].append(r) }

    /// A list opened from the Home root: zooms from its tile, swipe down hides it.
    func pushFromHome(_ r: Route) { paths[.home, default: NavigationPath()].append(HomeRoute(route: r)) }

    /// From now playing / queue: close them, then open the page (DECISIONS fix).
    func open(_ r: Route) {
        queueOpen = false; nowPlayingOpen = false; drawerOpen = false
        push(r)
    }

    func select(_ t: Tab) {
        if t == tab {
            if paths[t]?.isEmpty == false { paths[t] = NavigationPath() }
            else { scrollToTop[t, default: 0] += 1 }
        } else {
            // Home always lands on the Home root, never back where you were (owner, 11-11).
            if t == .home { paths[.home] = NavigationPath() }
            tab = t
        }
    }

    func reset() {
        tab = .home; paths = [.home: NavigationPath(), .search: NavigationPath(), .library: NavigationPath()]
        nowPlayingOpen = false; queueOpen = false; drawerOpen = false; deviceSheetOpen = false
    }

    func binding(_ t: Tab) -> Binding<NavigationPath> {
        Binding(get: { self.paths[t] ?? NavigationPath() }, set: { self.paths[t] = $0 })
    }
}
