import SwiftUI

/// An artist's Daily Mix (UI.md 6.3.6): `GET /api/tracks/{artistId}/mix?limit=50&tzo=`, dislikes dropped.
/// Its subtitle is the tile's (today's artists, §14.3).
struct DailyMixView: View {
    let artistId: String
    /// 1-based place on Home's Made For You shelf.
    let number: Int
    let seedName: String

    var body: some View {
        HomeMixPage(context: "mix:\(artistId)", title: L("Daily Mix {n}", ["n": number]),
                sub: HomeStore.shared.mixSub(artistId: artistId, seedName: seedName),
                color: Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(number - 1)],
                art: .artist(id: artistId, image: nil),
                radioSeed: .init(id: artistId, name: seedName)) { api, _ in
            try await api.mix(artistId, limit: 50).items
        }
    }
}
