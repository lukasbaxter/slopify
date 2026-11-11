import SwiftUI

/// A user's round picture with the initial fallback (UI.md 2.1): `#509bf5` disc with a black
/// initial (header, 14/700), or `drawer` style `#535353` with a white initial. The picture fills
/// its circle (DECISIONS: no zoom).
struct Avatar: View {
    var userId: String?
    var name: String?
    var size: CGFloat = 32
    var drawer = false

    @Environment(\.apiClient) private var api
    @State private var image: UIImage?

    var body: some View {
        let initial = String((name ?? "?").prefix(1)).uppercased()
        ZStack {
            Circle().fill(drawer ? Theme.Fixed.drawerAvatarFallback : Theme.Fixed.avatarFallback)
            Text(initial).font(.system(size: size * (drawer ? 22.0 / 56 : 14.0 / 32), weight: .bold))
                .foregroundStyle(drawer ? Color.white : Color.black)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: userId) {
            guard let userId, let url = CoverSource.user(id: userId).url(api, size: Int(size * 3)) else { image = nil; return }
            image = await ImageLoader.shared.image(url)
        }
        .accessibilityHidden(true)
    }
}

#Preview {
    HStack { Avatar(name: "lukas"); Avatar(name: "Ava", size: 56, drawer: true) }.padding().background(Theme.default.page)
}
