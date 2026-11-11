import SwiftUI
import PhotosUI

/// What the Edit details dialog edits.
struct LibraryEditDetails: Identifiable {
    let id: String
    var cover: String?
    var name: String
}

/// Edit details (UI.md 6.3.11): 60 % scrim (tap = close, no save), card `--bg-elevated-hi`
/// radius 8, padding 24, width `min(524, screen - 32)`, gap 16; title 20/700; 180 pt cover
/// picker; name field; Save pill (40 % while blank).
struct LibraryEditDetailsDialog: View {
    let edit: LibraryEditDetails
    var close: (_ then: (() -> Void)?) -> Void
    var onSave: (_ name: String, _ jpeg: Data?) -> Void

    @Environment(\.theme) private var theme
    @State private var name: String
    @State private var pick: PhotosPickerItem?
    @State private var preview: UIImage?
    @State private var jpeg: Data?
    @State private var appeared = false
    @FocusState private var focused: Bool

    init(edit: LibraryEditDetails, close: @escaping (_ then: (() -> Void)?) -> Void, onSave: @escaping (_ name: String, _ jpeg: Data?) -> Void) {
        self.edit = edit; self.close = close; self.onSave = onSave
        _name = State(initialValue: edit.name)
    }

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        GeometryReader { g in
            ZStack {
                Theme.Fixed.sheetScrim.opacity(appeared ? 1 : 0).ignoresSafeArea()
                    .onTapGesture { close(nil) }
                VStack(alignment: .leading, spacing: 16) {
                    Text(L("Edit details")).textStyle(.dialogTitle).foregroundStyle(theme.fg)
                    PhotosPicker(selection: $pick, matching: .images) {
                        ZStack {
                            theme.cardHover
                            if let preview {
                                Image(uiImage: preview).resizable().scaledToFill()
                            } else {
                                CoverImage(.playlist(id: edit.id, cover: edit.cover), size: 180, placeholder: .cardHover)
                            }
                        }
                        .frame(width: 180, height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.art))
                        .shadow(color: .black.opacity(0.55), radius: 20)
                    }
                    .buttonStyle(.pressPlain)
                    .accessibilityLabel(L("Choose photo"))
                    TextField("", text: $name, prompt: Text(L("Add a name")))
                        .textFieldStyle(.slopify(focused: focused))
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(save)
                    HStack {
                        Spacer()
                        PrimaryButton(L("Save"), action: save).disabled(trimmed.isEmpty)
                    }
                }
                .padding(24)
                .frame(width: min(524, g.size.width - 32))
                .background(theme.bgElevatedHi, in: RoundedRectangle(cornerRadius: Radius.dialog))
                .shadow(color: .black.opacity(0.3), radius: 12, y: 16)
                .opacity(appeared ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear {
            withAnimation(Motion.scrim) { appeared = true }
            DispatchQueue.main.async { focused = true }
        }
        .onChange(of: pick) { _, item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) else { return }
                preview = img
                jpeg = img.jpegData(compressionQuality: 0.9)
            }
        }
    }

    private func save() {
        guard !trimmed.isEmpty else { return }
        let n = trimmed, j = jpeg
        close { onSave(n, j) }
    }
}
