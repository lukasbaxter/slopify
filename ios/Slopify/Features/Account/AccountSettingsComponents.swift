import SwiftUI

/// Settings and its Scrobbling sub-page: an always-opaque `--bg-base` bar with the title always on
/// (mobile-library.css:214-217), over a `--bg-base` page. `DetailScaffold` paints `--page` behind
/// its scroll view, which differs from `--bg-base` on Midnight/Ember/Orchid, hence this one.
/// `chevron`: 18 pt (top bar) or 22 pt in a 48 hit box (`.settings-nav`).
struct AccountSettingsScaffold<Content: View>: View {
    var title: String
    var chevron: CGFloat = 18
    var topPadding: CGFloat = 0
    @ViewBuilder var content: () -> Content

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        GeometryReader { g in
            let inset = g.safeAreaInsets.top
            ScrollView {
                VStack(alignment: .leading, spacing: 0) { content() }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, Shell.topBar + inset + topPadding)
                    .padding(.horizontal, Spacing.gutter)
                    .padding(.bottom, 32 + Shell.contentBottom)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .ignoresSafeArea(edges: .top)
            .overlay(alignment: .top) { bar(inset: inset) }
        }
        .background(theme.bgBase.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }

    private func bar(inset: CGFloat) -> some View {
        HStack(spacing: 0) {
            Button { dismiss() } label: {
                IconView(.backChevron, size: chevron).foregroundStyle(theme.fg)
                    .frame(width: 48, height: Shell.topBar)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.pressFade)
            .padding(.leading, chevron > 18 ? 0 : Spacing.gutter - 8)
            .accessibilityLabel(L("Back"))
            Text(title).textStyle(.barTitle).foregroundStyle(theme.fg).lineLimit(1)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            Color.clear.frame(width: 48 + (chevron > 18 ? 0 : Spacing.gutter - 8), height: 1)
        }
        .frame(height: Shell.topBar)
        .padding(.top, inset)
        .background(theme.bgBase)
        .ignoresSafeArea(edges: .top)
    }
}

/// `h2` on the phone Settings page: 16/700, 24 above, 4 below.
struct AccountSettingsHeading: View {
    let title: String
    @Environment(\.theme) private var theme
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).font(.system(size: 16, weight: .bold)).foregroundStyle(theme.fg)
            .padding(.top, 24).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// `.setrow`: full-width button, min height 56, padding 8/0, gap 12; title 16/400, subtitle 13
/// `--fg-sub` one line; optional 16 pt chevron; disabled at 40 %. No press style (as the web).
struct AccountSettingsRow<Leading: View>: View {
    var title: String
    var subtitle: String?
    var chevron = true
    var bold = false
    var verticalPadding: (top: CGFloat, bottom: CGFloat) = (8, 8)
    var action: () -> Void
    @ViewBuilder var leading: () -> Leading

    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                leading()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 16, weight: bold ? .bold : .regular)).foregroundStyle(theme.fg)
                        .multilineTextAlignment(.leading)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if chevron { IconView(.chevronRight, size: 16).foregroundStyle(theme.fgSub) }
            }
            .padding(.top, verticalPadding.top).padding(.bottom, verticalPadding.bottom)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.4)
    }
}

extension AccountSettingsRow where Leading == EmptyView {
    init(title: String, subtitle: String?, chevron: Bool = true, action: @escaping () -> Void) {
        self.title = title; self.subtitle = subtitle; self.chevron = chevron; self.action = action
        self.leading = { EmptyView() }
    }
}

/// `.settings-caption`: 13 pt `--fg-sub`, line-height 1.45, margin 4 top / 16 bottom.
struct AccountSettingsCaption: View {
    let text: String
    @Environment(\.theme) private var theme
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).textStyle(TextStyle(size: 13, weight: .regular, lineHeight: 1.45)).foregroundStyle(theme.fgSub)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 4).padding(.bottom, 16)
    }
}

/// One option of a settings sheet: the green check or a theme dot in the 16 pt slot, then the label.
struct AccountSettingsOption: Identifiable {
    enum Mark { case none, check, dot(Color) }
    let id = UUID()
    var label: String
    var mark: Mark = .none
    var action: () -> Void
}

/// A settings option sheet (`settingsMenu`, UI.md 7.2.4): header with a 16 pt glyph in a 56 box,
/// title and subtitle, then rows. Tapping a row closes the sheet, then saves.
struct AccountSettingsSheet: Identifiable {
    let id = UUID()
    var icon: Icon
    var title: String
    var subtitle: String
    var options: [AccountSettingsOption]
}

struct AccountSettingsSheetView: View {
    let sheet: AccountSettingsSheet
    @Environment(\.theme) private var theme
    @Environment(\.closeSheet) private var closeSheet

    var body: some View {
        BottomSheetFrame {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    IconView(sheet.icon, size: 16).foregroundStyle(theme.fg).frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sheet.title).textStyle(.barTitle).foregroundStyle(theme.fg).lineLimit(1)
                        Text(sheet.subtitle).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 14).padding(.horizontal, 12).padding(.bottom, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(theme.fg(0.1)).frame(height: 1) }
                .padding(.bottom, 6)
                .accessibilityElement(children: .combine)
                ForEach(sheet.options) { o in
                    Button { closeSheet { o.action() } } label: {
                        HStack(spacing: 12) {
                            Group {
                                switch o.mark {
                                case .check: IconView(.check, size: 16)
                                case .dot(let c): Circle().fill(c)
                                case .none: Color.clear
                                }
                            }
                            .frame(width: 16, height: 16)
                            Text(o.label).font(.system(size: 16)).foregroundStyle(theme.fg).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 14).padding(.horizontal, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(AccountSettingsOptionStyle())
                    .accessibilityAddTraits(o.isChecked ? .isSelected : [])
                }
            }
        }
    }
}

private extension AccountSettingsOption {
    var isChecked: Bool { if case .check = mark { return true } else { return false } }
}

private struct AccountSettingsOptionStyle: ButtonStyle {
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? theme.fg(0.08) : .clear, in: RoundedRectangle(cornerRadius: 2))
    }
}

extension View {
    func accountSettingsSheet(_ sheet: Binding<AccountSettingsSheet?>) -> some View {
        overlayCover(item: sheet) { s, dismiss in
            SheetHost(dismiss: dismiss) { AccountSettingsSheetView(sheet: s) }
        }
    }
}
