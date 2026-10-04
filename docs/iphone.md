# iPhone

Until Slopify is in the App Store, there are two ways onto an iPhone.

## Home Screen web app (nothing to install)

In Safari open your Slopify address, tap Share, then **Add to Home Screen**.
It opens full screen with its own icon and never expires. The one thing it
cannot do is use the volume buttons for a speaker the music is playing on.

## The app, through SideStore

[SideStore](https://sidestore.io) installs apps signed with your own free
Apple ID and renews them on the phone over Wi-Fi, so they keep working past
Apple's 7 days without a computer. Each release has an unsigned
`Slopify-<version>.ipa` and a SideStore source that offers updates.

1. Set up SideStore with [iloader](https://github.com/nab138/iloader) and
   LocalDevVPN, following the
   [SideStore guide](https://docs.sidestore.io/docs/installation/prerequisites).
2. In SideStore, open **Sources**, tap **+**, and add:
   `https://github.com/lukasbaxter/slopify/releases/latest/download/sidestore-source.json`
3. Install Slopify from that source. New releases show up under Updates.

Keep LocalDevVPN connected when SideStore installs or refreshes, and open
SideStore every few days (or add its refresh to a Shortcuts automation) so
the signature is renewed before it runs out. A free Apple ID can have three
sideloaded apps at a time; SideStore is one of them.

To point the app at your own server, build it with
`EXPO_PUBLIC_SLOPIFY_URL=https://music.example.com/ mobile/build-ipa.sh` and
install that `.ipa` in SideStore from the Files app.
