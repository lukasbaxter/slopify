import SwiftUI

/// Modal text field (UI.md 2.10): padding 12/14, radius 4, 1 pt border #555 (white while
/// focused), `--field` background, 15 pt.
///
///     TextField("", text: $name).textFieldStyle(.slopify(focused: isFocused))
struct SlopifyFieldStyle: TextFieldStyle {
    var focused = false
    @Environment(\.theme) private var theme

    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.system(size: 15))
            .foregroundStyle(theme.fg)
            .padding(.vertical, 12).padding(.horizontal, 14)
            .background(theme.field, in: RoundedRectangle(cornerRadius: Radius.art))
            .overlay(RoundedRectangle(cornerRadius: Radius.art).strokeBorder(focused ? theme.fg : Theme.Fixed.textFieldBorder, lineWidth: 1))
    }
}

extension TextFieldStyle where Self == SlopifyFieldStyle {
    static func slopify(focused: Bool = false) -> SlopifyFieldStyle { SlopifyFieldStyle(focused: focused) }
}

/// Rounded search-style field with a leading magnifier (Library find, Liked find): `--chip`
/// background, radius 4, 16 pt glyph `--fg-sub`, clear button when not empty.
struct SearchField: View {
    var placeholder: String
    @Binding var text: String
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            IconView(.magnifier, size: 16).foregroundStyle(theme.fgSub)
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(theme.fgSub))
                .font(.system(size: 14)).foregroundStyle(theme.fg)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
            if !text.isEmpty {
                Button { text = "" } label: { IconView(.close, size: 12).foregroundStyle(theme.fgSub).frame(width: 28, height: 28) }
                    .buttonStyle(.pressFade).accessibilityLabel(L("Clear"))
            }
        }
        .padding(.leading, 10)
        .frame(height: 36)
        .background(theme.chip, in: RoundedRectangle(cornerRadius: Radius.art))
    }
}

#Preview {
    struct P: View {
        @State var s = "OK Computer"
        @State var q = ""
        var body: some View {
            VStack(spacing: 16) {
                TextField("", text: $s).textFieldStyle(.slopify())
                TextField("", text: $s).textFieldStyle(.slopify(focused: true))
                SearchField(placeholder: "Find in Liked Songs", text: $q)
            }
            .padding().background(Theme.default.bgElevatedHi)
        }
    }
    return P()
}
