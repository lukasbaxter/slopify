import SwiftUI

/// A themed playlist made for this listener (Search's Made For You row, §14.5):
/// `GET /api/made/{id}`, shown like one of Your top mixes: the server's drawn cover as is (no
/// band), its title, its description as the subtitle.
struct MadeForYouView: View {
    let item: MadeForYou

    var body: some View {
        HomeMixPage(context: SearchLogic.madeContext(item.id), title: item.title,
                    sub: item.description.flatMap { $0.isEmpty ? nil : $0 },
                    color: HomeLogic.color(item.color),
                    art: item.art.map { .drawn(id: $0) },
                    radioSeed: nil) { api, _ in
            try await api.made(item.id).items
        }
    }
}

/// A Made For You card: the drawn cover, title, description.
struct MadeForYouCard: View {
    let item: MadeForYou
    var action: () -> Void

    var body: some View {
        MediaCard(title: item.title, subtitle: item.description, style: .home, action: action) {
            HomeMixArt(source: item.art.map { .drawn(id: $0) }, color: HomeLogic.color(item.color), label: nil, pixelSize: 150)
        }
    }
}
