import SwiftUI

/// `.login input` on the phone (app.css:1400): `--page` fill, 1 pt #727272 border (white focused),
/// radius 4, padding 14, 16 pt.
struct LoginFieldStyle: TextFieldStyle {
    var focused: Bool
    @Environment(\.theme) private var theme

    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(size: 16)).foregroundStyle(theme.fg).tint(theme.fg)
            .padding(14)
            .background(theme.page, in: RoundedRectangle(cornerRadius: Radius.art))
            .overlay(RoundedRectangle(cornerRadius: Radius.art).strokeBorder(focused ? theme.fg : theme.fgFaint, lineWidth: 1))
    }
}

/// `.login label`: 14/700 `--fg` above its field, gap 8.
struct LoginLabeled<Field: View>: View {
    let title: String
    @ViewBuilder var field: () -> Field
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 14, weight: .bold)).foregroundStyle(theme.fg)
            field()
        }
    }
}

/// `.login .primary`: full-width `--accent` pill, `--on-accent` 16/700, min height 48, 30 % disabled.
struct LoginButton: View {
    let title: String
    var enabled: Bool
    var action: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.onAccent)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(theme.accent, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.pressFade)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.3)
        .padding(.top, 8)
    }
}

/// `.login h1` + `.login-sub` on the phone: 28/800 -0.5 centred, then 15 `--fg-sub`, margin-bottom 16.
struct LoginHeading: View {
    let title: String
    let subtitle: String
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.system(size: 28, weight: .heavy)).tracking(-0.5).foregroundStyle(theme.fg)
                .multilineTextAlignment(.center).frame(maxWidth: .infinity)
            Text(subtitle).font(.system(size: 15)).foregroundStyle(theme.fgSub)
                .multilineTextAlignment(.center).frame(maxWidth: .infinity)
                .padding(.bottom, 16)
        }
    }
}

/// `.login` page on the phone: black, top aligned, padding-top 80 + inset, form padding 0/24, gap 16.
struct LoginPage<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content() }
                .padding(.horizontal, 24)
                .padding(.top, 80)
                .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollBounceBehavior(.basedOnSize)
    }
}
