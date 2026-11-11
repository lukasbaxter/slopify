import SwiftUI

/// The phone account drawer (UI.md 2.7, 7.1; web App.jsx:1594-1640, app.css:1205-1223).
/// Scrim `rgba(0,0,0,.55)` fading in, a `--page` panel `min(82 %, 340)` wide sliding in from the
/// left over 0.25 s. Tap the scrim or swipe left to close.
// TODO(lead): MainShell wraps this in `.transition(.move(edge: .leading))`; the drawer animates
// itself (scrim fade + slide), so `.transition(.identity)` there is what matches the web.
struct AccountDrawer: View {
    @Environment(Navigator.self) private var nav
    @Environment(Account.self) private var account
    @Environment(\.theme) private var theme
    @State private var appeared = false

    var body: some View {
        GeometryReader { g in
            let width = min(g.size.width * 0.82, 340)
            ZStack(alignment: .leading) {
                Theme.Fixed.drawerScrim
                    .opacity(appeared ? 1 : 0)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .accessibilityLabel(L("Close"))
                    .accessibilityAddTraits(.isButton)
                panel(height: g.size.height)
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .background(theme.page.ignoresSafeArea())
                    .compositingGroup()
                    .shadow(color: .black.opacity(0.7), radius: 30)
                    .offset(x: appeared ? 0 : -(width + 60))
                    .gesture(swipeToClose)
            }
        }
        .onAppear { withAnimation(Motion.drawerIn) { appeared = true } }
    }

    private func panel(height: CGFloat) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                row(.drawerHistory, L("Listening history")) { nav.open(.history) }
                row(.drawerDownloads, L("Downloads")) { nav.open(.downloads) }
                row(.drawerSettings, L("Settings")) { nav.open(.settings) }
                Spacer(minLength: 0)
                row(.drawerLogOut, L("Log out")) { logOut() }
            }
            .padding(.vertical, 24)
            .frame(minHeight: height, alignment: .top)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize)
    }

    private var header: some View {
        Button { nav.open(.profile) } label: {
            HStack(spacing: 12) {
                AccountAvatar(userId: account.user?.id, name: account.user?.name, size: 56,
                              background: Theme.Fixed.drawerAvatarFallback, initialSize: 22, initialColor: .white)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.user?.name.isEmpty == false ? account.user!.name : L("Signed in"))
                        .font(.system(size: 20, weight: .bold)).foregroundStyle(theme.fg).lineLimit(1)
                    Text(L("View profile")).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 8).padding(.horizontal, 20).padding(.bottom, 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
        .padding(.bottom, 8)
    }

    private func row(_ icon: Icon, _ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 16) {
                IconView(icon, size: 24)
                Text(title).font(.system(size: 16)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.fg)
            .padding(.vertical, 14).padding(.horizontal, 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressFade)
    }

    /// App.jsx:1605-1611: dx < -50 and |dx| > 1.5 |dy|.
    private var swipeToClose: some Gesture {
        DragGesture(minimumDistance: 10).onChanged { v in
            let dx = v.translation.width, dy = v.translation.height
            if AccountDrawerLogic.isCloseSwipe(dx: dx, dy: dy) { close() }
        }
    }

    private func close() { nav.drawerOpen = false }

    private func logOut() {
        close()
        Task { await account.signOut() }
    }
}

enum AccountDrawerLogic {
    static func isCloseSwipe(dx: CGFloat, dy: CGFloat) -> Bool { dx < -50 && abs(dx) > abs(dy) * 1.5 }
}

#Preview {
    let app = AppModel()
    return Color.gray.overlay { AccountDrawer() }
        .environment(app.nav).environment(app.account)
}
