import SwiftUI

/// Your Top Songs {year} (UI.md 6.3.6): `GET /api/top-songs/{year}?tzo=`, shown like a Daily Mix.
struct TopSongsView: View {
    let year: Int
    let colorIndex: Int

    var body: some View {
        let top = HomeStore.shared.data.topYears.first { $0.year == year }?.top
        HomeMixPage(context: "top:\(year)", title: L("Your Top Songs {year}", ["year": year]),
                sub: HomeLogic.topSongsSub(year, currentYear: Calendar.current.component(.year, from: Date())),
                color: Theme.Fixed.mixPalette[HomeLogic.mixColorIndex(colorIndex)],
                art: top.map { .album(id: $0.albumId, art: $0.cover) },
                radioSeed: nil) { api, _ in
            try await api.topSongs(year: year)
        }
    }
}
