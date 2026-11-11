import SwiftUI

/// What reaches the listener (QualityBadge.jsx `deliveredFormat` + `formatLabel`, UI.md 3.5, 4.3.7).
enum DeliveredFormat {
    /// The local stream mode: `file` (original), or an HLS/whole profile.
    enum Mode: Hashable, Sendable { case file, hls, mp3 }

    /// `deviceKind` is the session device's kind (`local` = this phone).
    /// `profile`: `alac`, `aac-320`, `aac-160`, `aac-96` (already capped by the link watch).
    static func delivered(_ f: Format?, deviceKind: String, mode: Mode = .hls, profile: String = "aac-320") -> Format? {
        guard let f else { return nil }
        if deviceKind != "local" || mode == .file { return f }
        if profile == "alac" {
            if f.lossless == true { var g = f; g.codec = "ALAC"; return g }
            return f
        }
        let bitrate: Double = ["aac-320": 320_000, "aac-160": 160_000, "aac-96": 96_000][profile] ?? 320_000
        return Format(codec: mode == .hls ? "AAC" : "MP3", lossless: false, bitrate: bitrate, sampleRate: nil, bitDepth: nil)
    }

    /// "FLAC 24-bit 96kHz", "FLAC 44.1kHz", "AAC 320kbps", or the bare codec. Nil without a codec.
    static func label(_ f: Format?) -> String? {
        guard let f, let codec = f.codec, !codec.isEmpty else { return nil }
        if f.lossless == true {
            var parts = [codec]
            if let b = f.bitDepth, b > 16 { parts.append("\(Self.num(b))-bit") }
            if let sr = f.sampleRate, sr > 0 {
                let k = sr / 1000
                parts.append(k == k.rounded() ? "\(Int(k))kHz" : String(format: "%.1fkHz", k))
            }
            return parts.joined(separator: " ")
        }
        if let br = f.bitrate, br > 0 { return "\(codec) \(ColorMath.jsRound(br / 1000))kbps" }
        return codec
    }

    private static func num(_ d: Double) -> String { d == d.rounded() ? String(Int(d)) : String(d) }
}

/// The quality tag under the artist in now playing and in the device sheet (UI.md 3.5):
/// 12/500 (11 in the sheet: `small`), line height 14, letter-spacing .02em, one line;
/// `--accent-ink` when lossless, `--fg-dim` otherwise. Hidden when the label is nil.
struct QualityBadge: View {
    var format: Format?
    var small = false
    @Environment(\.theme) private var theme

    var body: some View {
        if let text = DeliveredFormat.label(format) {
            let lossless = format?.lossless == true
            Text(text)
                .font(.system(size: small ? 11 : 12, weight: .medium))
                .tracking((small ? 11 : 12) * 0.02)
                .lineLimit(1)
                .frame(height: 14)
                .foregroundStyle(lossless ? theme.accentInk : theme.fgDim)
                .accessibilityLabel("\(text), \(lossless ? L("Lossless") : L("Compressed"))")
        }
    }
}

#Preview {
    VStack(alignment: .leading) {
        QualityBadge(format: Format(codec: "FLAC", lossless: true, bitrate: nil, sampleRate: 96000, bitDepth: 24))
        QualityBadge(format: DeliveredFormat.delivered(Format(codec: "FLAC", lossless: true, bitrate: nil, sampleRate: 44100, bitDepth: 16), deviceKind: "local"))
    }
    .padding().background(Theme.default.page)
}
