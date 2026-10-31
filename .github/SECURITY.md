# Security

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/lukasbaxter/slopify/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it and the
version (Settings › About, or the image tag).

You will get a reply within a week. A confirmed problem is fixed in a release
and credited to you in the advisory, unless you would rather not be named.

## Supported versions

Only the latest release gets security fixes. Slopify updates in place (the
database migrates itself), so staying current is the way to stay safe.

## Running it safely

- Change the first admin password on first login (it is forced).
- Put the server behind HTTPS (a reverse proxy) before exposing it to the
  internet; the apps send sign-in tokens with every request.
- Sign-ins can be revoked per device in the apps (Settings), and changing a
  password signs out every other device.
- Keep `/data` (the database and sign-ins) out of public shares and back it up.
