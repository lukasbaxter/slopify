import SwiftUI

/// Cache-bust for the signed-in user's picture after an upload (web `avatarV`).
// TODO(lead): move to Design so the shell header `Avatar` refreshes after an upload too.
@MainActor @Observable
final class AccountAvatarVersion {
    static let shared = AccountAvatarVersion()
    /// Upload time in ms; nil until this run uploads one.
    var bust: Int?

    func bumped() { bust = Int(Date().timeIntervalSince1970 * 1000) }
}

/// A round user picture over its initial: the initial shows through while loading, on a 404 or
/// a failed load. The picture is aspect-filled into the circle (DECISIONS: no zoom).
struct AccountAvatar: View {
    var userId: String?
    var name: String?
    var size: CGFloat
    var background: Color
    var initialSize: CGFloat
    var initialWeight: Font.Weight = .bold
    var initialColor: Color

    @Environment(\.apiClient) private var api

    var body: some View {
        ZStack {
            Circle().fill(background)
            Text(AccountProfileLogic.initial(name))
                .font(.system(size: initialSize, weight: initialWeight))
                .foregroundStyle(initialColor)
            CoverImage(.url(url), size: size, shape: .circle, placeholder: .none)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var url: URL? {
        guard let api, let userId else { return nil }
        if let v = AccountAvatarVersion.shared.bust { return api.url("api/users/\(userId)/avatar", ["v": String(v)]) }
        return api.avatarURL(userId: userId)
    }
}
