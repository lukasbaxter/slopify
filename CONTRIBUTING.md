# Contributing

Thanks for helping. Bug reports, fixes and features are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Be kind: this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development

```
npm install
npm run fixtures        # a 30-track fake library in fixtures/music (needs ffmpeg)
MUSIC_DIR=$PWD/fixtures/music CONFIG_DIR=$PWD/data npm run dev
npm run dev -w web      # the web app on :5180
```

Before sending a pull request:

```
npm run lint
npm test                # server tests
npm run e2e             # browser tests against the fixture library
```

The Home Assistant integration (`custom_components/slopify`) has its own tests:

```
python3 -m venv .venv && .venv/bin/pip install -r ha/requirements_test.txt
cd ha && ../.venv/bin/pytest
```

If you change dependencies, run `npm run licenses` and commit the updated
`THIRD_PARTY_LICENSES.md`; it fails on a license the project cannot ship.

## Pull requests

- Keep each pull request to one change, with tests for behaviour it adds or fixes.
- Describe what changed and why, as you would for someone who has not seen the code.
- Anything a self-hoster would notice (a new setting, a changed default, a new
  outside service) goes in the README; a new outside service also goes in
  [PRIVACY.md](PRIVACY.md).

## License of contributions

Slopify is licensed under the [GNU AGPL v3 or later](LICENSE); the Home
Assistant integration in `custom_components/slopify` is licensed under the
[Apache License 2.0](custom_components/slopify/LICENSE). By sending a
contribution you agree that it is licensed under the license of the part of the
repository it changes.
