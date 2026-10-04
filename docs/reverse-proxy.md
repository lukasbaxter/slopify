# HTTPS and a reverse proxy

On your home network you can use Slopify at `http://<server>:8080` as is. To
reach it from outside, put it behind a reverse proxy that adds HTTPS: the apps
send a sign-in token with every request, and that should never cross the
internet unencrypted.

What the proxy has to do:

- **Pass WebSockets on `/api/ws`.** That socket carries the shared session
  (what is playing, on which device, the queue). Without it the apps load and
  browse but playback control and Home Assistant's player stay dead.
- **Not buffer audio.** Songs are streamed with range requests; buffering
  makes seeking slow and long songs start late.
- **Forward the client address** (`X-Forwarded-For`). Slopify trusts one
  proxy hop by default (`TRUST_PROXY=1`) and rate-limits sign-ins per client
  address. With two proxies in a row (say Cloudflare, then nginx) set
  `TRUST_PROXY=2`.

Keep speakers on the LAN address: `PUBLIC_URL` is what Chromecast and BluOS
speakers fetch audio from, and it should stay the server's LAN address even
when you use a public hostname in the apps.

## Caddy

Caddy handles HTTPS certificates, WebSockets and forwarded headers on its own:

```
music.example.com {
	reverse_proxy 192.168.1.10:8080 {
		flush_interval -1
	}
}
```

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name music.example.com;
    # ssl_certificate / ssl_certificate_key: from certbot or your own

    location / {
        proxy_pass http://192.168.1.10:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # the live session socket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        # stream audio as it comes
        proxy_buffering off;
        # Spotify history imports (an extended history zip can be hundreds of MB)
        client_max_body_size 1g;
    }
}

# once, in the http block:
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
```

## Traefik

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.slopify.rule=Host(`music.example.com`)
      - traefik.http.routers.slopify.tls.certresolver=letsencrypt
      - traefik.http.services.slopify.loadbalancer.server.port=8080
```

Traefik passes WebSockets without extra settings. With `network_mode: host`,
Traefik reaches the container through the host's address instead of a
Docker network: point a file-provider service at `http://192.168.1.10:8080`.

## Checking it

- `https://music.example.com/api/healthz` answers `{"ok":true}`.
- Sign in from your phone off Wi-Fi, play a song, and pause it from another
  device: if the pause arrives, WebSockets are passing.
