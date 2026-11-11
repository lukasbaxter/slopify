import SwiftUI

/// A list opened straight from the Home root (owner, 11-11): it zooms out of its tile and a
/// swipe down hides it back into the tile. Pages opened anywhere else push normally.
struct HomeRoute: Hashable { let route: Route }

private struct HomeZoomKey: EnvironmentKey { static let defaultValue: Namespace.ID? = nil }

extension EnvironmentValues {
    var homeZoom: Namespace.ID? {
        get { self[HomeZoomKey.self] }
        set { self[HomeZoomKey.self] = newValue }
    }
}

extension View {
    /// Mark a Home tile as the zoom source for `route`.
    @ViewBuilder func homeZoomSource(_ route: Route) -> some View {
        modifier(HomeZoomSource(route: route))
    }
}

private struct HomeZoomSource: ViewModifier {
    let route: Route
    @Environment(\.homeZoom) private var ns
    func body(content: Content) -> some View {
        if let ns { content.matchedTransitionSource(id: HomeRoute(route: route), in: ns) } else { content }
    }
}
