import SwiftUI

/// An artist's Daily Mix (UI.md 6.3.6): `GET /api/tracks/{artistId}/mix?limit=50&tzo=`, dislikes dropped.
struct DailyMixView: View {
    let artistId: String
    /// 1-based place on Home's Made For You shelf.
    let number: Int
    let seedName: String

    var body: some View {
        HomeMixPage(context: "mix:\(artistId)", title: L("Daily Mix {n}", ["n": number]),
                sub: seedName.isEmpty ? nil : L("{name} and more", ["name": seedName]),
                color: Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(number - 1)],
                art: .artist(id: artistId, image: nil),
                radioSeed: artistId) { api in
            try await api.mix(artistId, limit: 50).items
        }
    }
}
