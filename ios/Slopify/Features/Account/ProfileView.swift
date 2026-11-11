import SwiftUI
import PhotosUI

/// Phone Profile (UI.md 7.4; web Library.jsx:1029-1109, App.jsx:938-955): grey hero with the
/// 128 pt avatar (tap to change it), Edit + ⋯, then top artists, top tracks and playlists.
struct ProfileView: View {
    @Environment(AppModel.self) private var app
    @Environment(Account.self) private var account
    @Environment(Navigator.self) private var nav
    @Environment(Player.self) private var player
    @Environment(\.theme) private var theme

    @State private var loading = true
    @State private var tracks: [Track] = []
    @State private var artists: [AccountProfileLogic.TopArtist] = []
    @State private var playlists: [Playlist] = []
    @State private var showAllTracks = false
    @State private var pickerOpen = false
    @State private var picked: PhotosPickerItem?
    @State private var menuOpen = false
    @State private var trackMenu: MenuSheet?
    @State private var nameDialog: NameDialog?

    private var name: String { account.user?.name.isEmpty == false ? account.user!.name : L("You") }

    var body: some View {
        DetailScaffold(title: name, heroColor: Theme.Fixed.profileHero) {
            AccountProfileHero(name: name, userId: account.user?.id, playlistCount: playlists.count) { pickerOpen = true }
            actions
            VStack(alignment: .leading, spacing: 0) {
                if !artists.isEmpty { artistsSection(first: true) }
                if !tracks.isEmpty { tracksSection(first: artists.isEmpty) }
                if !playlists.isEmpty { playlistsSection(first: artists.isEmpty && tracks.isEmpty) }
                if loading { PlaceholderNote(text: L("Loading…")) }
            }
            .padding(.top, 8).padding(.bottom, 24)
        }
        .photosPicker(isPresented: $pickerOpen, selection: $picked, matching: .images)
        .onChange(of: picked) { _, item in
            guard let item else { return }
            picked = nil
            Task { await upload(item) }
        }
        .overlayCover(item: Binding(get: { menuOpen ? AccountProfileMenuToken() : nil }, set: { menuOpen = $0 != nil })) { _, dismiss in
            SheetHost(dismiss: dismiss) {
                AccountProfileMenu(name: name, onPhoto: { pickerOpen = true }, onSettings: { nav.push(.settings) })
            }
        }
        .contextMenuSheet($trackMenu)
        .nameDialog($nameDialog)
        .task { await load() }
    }

    // MARK: actions row

    private var actions: some View {
        HStack(spacing: 8) {
            Button { pickerOpen = true } label: {
                Text(L("Edit")).font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                    .padding(.horizontal, 16).frame(minHeight: 32)
                    .overlay(Capsule().strokeBorder(theme.fgFaint, lineWidth: 1))
                    .contentShape(Capsule())
            }
            .buttonStyle(.pressFade)
            Button { menuOpen = true } label: {
                IconView(.dots, size: 24).foregroundStyle(theme.fgDim).frame(width: 32, height: 32)
            }
            .buttonStyle(.pressFade)
            .accessibilityLabel(L("More options"))
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Spacing.gutter).padding(.bottom, 8)
    }

    // MARK: sections

    private func head(_ title: String, first: Bool, sub: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).textStyle(.sectionDetail).foregroundStyle(theme.fg).lineLimit(2)
                .padding(.top, first ? 16 : 24).padding(.bottom, sub ? 4 : 12)
                .accessibilityAddTraits(.isHeader)
            if sub {
                Text(L("Only visible to you")).font(.system(size: 13)).foregroundStyle(theme.fgSub).padding(.bottom, 8)
            }
        }
        .padding(.horizontal, Spacing.gutter)
    }

    private func artistsSection(first: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            head(L("Top artists this month"), first: first, sub: true)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(artists) { a in
                        MediaCard(.artist(id: a.id, image: nil), title: a.name, subtitle: L("Artist"), round: true, artSize: 120) {
                            nav.push(.artist(id: a.id))
                        }
                        .frame(width: 120)
                    }
                }
                .padding(.horizontal, Spacing.gutter)
            }
        }
    }

    private func tracksSection(first: Bool) -> some View {
        let shown = showAllTracks ? tracks : Array(tracks.prefix(5))
        return VStack(alignment: .leading, spacing: 0) {
            head(L("Top tracks this month"), first: first, sub: true)
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, t in
                TrackRow(track: t, showArt: true, isCurrent: player.current?.id == t.id,
                         isPlaying: player.current?.id == t.id && player.isPlaying,
                         onTap: { player.play(tracks, startAt: i, context: "profile") },
                         onMore: { trackMenu = TrackMenuBuilder(app: app) { nameDialog = $0 }.sheet(t) },
                         onTouchDown: { player.prewarm(t) })
            }
            if tracks.count > 5 {
                Button { showAllTracks.toggle() } label: {
                    Text(showAllTracks ? L("See less") : L("See all"))
                        .font(.system(size: 13, weight: .bold)).foregroundStyle(theme.fg)
                        .padding(.horizontal, 16).frame(minHeight: 32)
                        .overlay(Capsule().strokeBorder(theme.fgFaint, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.pressFade)
                .padding(.top, 8).padding(.horizontal, Spacing.gutter)
            }
        }
    }

    private func playlistsSection(first: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            head(L("Public Playlists"), first: first, sub: false)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(playlists) { p in
                        MediaCard(.init(p), title: p.name, subtitle: L("By {name}", ["name": name]), artSize: 120) {
                            nav.push(.playlist(id: p.id))
                        }
                        .frame(width: 120)
                    }
                }
                .padding(.horizontal, Spacing.gutter)
            }
        }
    }

    // MARK: data

    private func load() async {
        let api = account.api
        async let home = try? api.home()
        async let lists = try? api.playlists()
        let top = Array(((await home)?.topTracks ?? []).prefix(60))
        tracks = Array(top.prefix(10))
        artists = AccountProfileLogic.topArtists(top)
        playlists = (await lists) ?? []
        loading = false
    }

    private func upload(_ item: PhotosPickerItem) async {
        guard let raw = try? await item.loadTransferable(type: Data.self), let jpeg = AccountProfilePhoto.jpeg(raw) else {
            ToastCenter.shared.show(L("Could not upload: {error}", ["error": L("not an image")]))
            return
        }
        do {
            let _: OK = try await account.api.upload("api/users/me/avatar", data: jpeg, contentType: "image/jpeg")
            if let id = account.user?.id { ImageLoader.shared.evict(account.api.avatarURL(userId: id)) }
            AccountAvatarVersion.shared.bumped()
            ToastCenter.shared.show(L("Profile picture updated"))
        } catch {
            ToastCenter.shared.show(L("Could not upload: {error}", ["error": AccountProfilePhoto.message(error)]))
        }
    }
}

private struct AccountProfileMenuToken: Identifiable { var id: Int { 0 } }

/// The 7.4.1 hero: flat #4a4a4a fading into `--bg-base`, dark tokens on light themes.
private struct AccountProfileHero: View {
    var name: String
    var userId: String?
    var playlistCount: Int
    var onAvatar: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.detailTopInset) private var topInset

    var body: some View {
        VStack(spacing: 12) {
            Button(action: onAvatar) {
                AccountAvatar(userId: userId, name: name, size: 128, background: theme.sheet,
                              initialSize: 56, initialWeight: .heavy, initialColor: theme.fg)
                    .shadow(color: .black.opacity(0.5), radius: 12, y: 8)
            }
            .buttonStyle(.pressFade)
            .accessibilityLabel(L("Choose photo"))
            .padding(.bottom, 12)
            VStack(spacing: 4) {
                Text(name).font(.system(size: 24, weight: .heavy)).tracking(-0.3)
                    .foregroundStyle(theme.fg).lineLimit(2).multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(AccountProfileLogic.playlistCount(playlistCount)).font(.system(size: 13)).foregroundStyle(theme.fgSub)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Shell.topBar + topInset).padding(.horizontal, Spacing.gutter).padding(.bottom, 24)
        .background {
            ZStack {
                Theme.Fixed.profileHero.color
                LinearGradient(colors: [theme.page(0), theme.bgBase], startPoint: .top, endPoint: .bottom)
            }
            .ignoresSafeArea(edges: .top)
        }
        .heroIsland()
        .reportsHeroHeight()
    }
}

/// The ⋯ sheet: initial disc header, Change photo, Settings.
private struct AccountProfileMenu: View {
    var name: String
    var onPhoto: () -> Void
    var onSettings: () -> Void
    @Environment(\.theme) private var theme
    @Environment(\.closeSheet) private var closeSheet

    var body: some View {
        BottomSheetFrame {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(Theme.Fixed.drawerAvatarFallback)
                        Text(AccountProfileLogic.initial(name)).font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
                    }
                    .frame(width: 56, height: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name).textStyle(.barTitle).foregroundStyle(theme.fg).lineLimit(1)
                        Text(L("Profile")).font(.system(size: 13)).foregroundStyle(theme.fgSub).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 14).padding(.horizontal, 12).padding(.bottom, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(theme.fg(0.1)).frame(height: 1) }
                .padding(.bottom, 6)
                .accessibilityElement(children: .combine)
                MenuList(header: nil, items: [
                    MenuItem(L("Change photo"), icon: .photo, action: onPhoto),
                    MenuItem(L("Settings"), icon: .gear, action: onSettings),
                ]) { item in closeSheet { item.action?() } }
            }
        }
    }
}

/// Photo bytes for the avatar upload: any picked image re-encoded as JPEG, at most 1024 px
/// (the server keeps one 512 px rendition, API.md §3.3; HEIC is not among its types).
enum AccountProfilePhoto {
    static func jpeg(_ data: Data, maxSide: CGFloat = 1024) -> Data? {
        guard let img = UIImage(data: data), img.size.width > 0, img.size.height > 0 else { return nil }
        let scale = min(1, maxSide / max(img.size.width * img.scale, img.size.height * img.scale))
        let target = CGSize(width: (img.size.width * img.scale * scale).rounded(), height: (img.size.height * img.scale * scale).rounded())
        let fmt = UIGraphicsImageRendererFormat.default(); fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: target, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: target)) }
        return out.jpegData(compressionQuality: 0.9)
    }

    static func message(_ e: Error) -> String { e.localizedDescription }
}
