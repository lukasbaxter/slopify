import SwiftUI

/// Go to radio's page (API.md §14.4): the listener's radio of an artist, song, album or playlist,
/// drawn like a Daily Mix page. It starts playing from the top as it opens.
struct RadioView: View {
    let seedId: String
    /// The seed's name from the caller, for the title before the radio loads.
    let name: String?

    @State private var radio: Radio?

    var body: some View {
        let title = HomeRadioLogic.title(radio?.seed.name ?? name)
        HomeMixPage(context: HomeRadioLogic.context(seedId), title: title,
                    sub: HomeLogic.mixSub(radio?.artists),
                    color: Theme.Fixed.mixPalette[HomeRadioLogic.colorIndex(seedId)],
                    art: radio.map { HomeRadioLogic.art($0.seed) } ?? HomeRadioLogic.hintArt(seedId),
                    radioSeed: nil, radio: true) { api, refresh in
            let r = try await api.radio(seedId, refresh: refresh)
            radio = r
            return r.items
        }
    }
}

/// The radio page's pieces, as API.md §14.4 words them (the web's Library.jsx openRadio).
enum HomeRadioLogic {
    /// The player context of a radio.
    static func context(_ seedId: String) -> String { "radio:\(seedId)" }

    static func title(_ seedName: String?) -> String {
        guard let n = seedName, !n.isEmpty else { return "" }
        return L("{name} Radio", ["name": n])
    }

    /// `MIX_COLORS[(sum of the seed id's UTF-16 code units) % 8]`.
    static func colorIndex(_ seedId: String) -> Int { seedId.utf16.reduce(0) { $0 + Int($1) } % 8 }

    /// An artist: their picture; a song or album: the album cover; a playlist: its picture.
    static func art(_ s: Radio.Seed) -> CoverSource? {
        switch s.kind {
        case "artist": return .artist(id: s.artistId ?? s.id, image: nil)
        case "playlist": return .playlist(id: s.id, cover: nil)
        default: return s.albumId.map { .album(id: $0, art: nil) }
        }
    }

    /// Before the answer: only a playlist id says what it is.
    static func hintArt(_ seedId: String) -> CoverSource? { seedId.hasPrefix("pl_") ? .playlist(id: seedId, cover: nil) : nil }
}
