import SwiftUI

/// One of Your top mixes (API.md §14.3): `GET /api/home/mixes/{genre}`, shown like a Daily Mix,
/// the server's drawn tile as its cover (no band), its title the mix's name ("Hip-Hop Mix").
struct TopMixView: View {
    let genre: String

    var body: some View {
        let m = HomeStore.shared.topMixes.first { $0.genre == genre }
        HomeMixPage(context: HomeLogic.topMixContext(genre), title: m?.name ?? genre,
                    sub: HomeLogic.mixSub(m?.artists),
                    color: HomeLogic.color(m?.color),
                    art: m?.art.map { .drawn(id: $0) },
                    radioSeed: nil) { api, _ in
            try await api.homeMixTracks(genre: genre)
        }
    }
}
