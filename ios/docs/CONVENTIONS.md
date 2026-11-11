# Slopify iOS: rules for everyone working on it

Native SwiftUI client for the Slopify server. No WebView, no JS.
The reference implementation is the web app's **phone layout** (web/src). The owner's
rule: the UI stays the same as the web app. Same screens, same order, same look.
Do not invent new layouts, labels, sections or features. When the web app does it, do it
the same way; when unsure, read the cited web source and match it.

Specs: `docs/API.md` (server contract), `docs/UI.md` (screens and visuals),
`docs/TASKS.md` (who owns what, status).

## Ownership (strict)
- You own only the folders your task names. Do not edit files outside them.
- `Slopify/App/`, `Slopify/Core/`, `Slopify/Design/`, `project.yml`, `Makefile` belong to the
  lead. Need a change there (new model field, new endpoint, new shared component)? Do not
  edit it. Put the request in your final report under **Requests**, and work around it
  locally in your folder in the meantime (a private extension, a local helper) marked
  `// TODO(lead): <what>`.
- Never edit `docs/API.md` / `docs/UI.md`. Report errors in them under **Spec issues**.
- Never touch anything outside `ios/` (server, web, mobile, CI).
- No git commits, no pushes, no installs on a device. The lead commits.

## Build and test
- `make build DD=build/dd-<your-task>` must pass before you report done. Use your own DD
  dir so parallel builds do not collide. Never delete another task's dd dir.
- `make test DD=build/dd-<your-task>`; add tests in `SlopifyTests/<YourArea>/` for logic
  (parsing, state machines, formatting). UI does not need snapshot tests.
- Zero warnings in your files.
- Network tests never hit a real server. Use `URLProtocol` stubs with JSON copied from API.md.

## Code style
- Swift 5 mode, iOS 17+. SwiftUI + `@Observable` (Observation). Swift concurrency
  (async/await), `@MainActor` for UI state. No Combine unless AVFoundation forces it.
- No third-party packages. Apple frameworks only.
- One type per file where reasonable; files named after the main type.
- Colors, fonts, spacing, icons only from `Design/` tokens. No hex literals in feature code.
- User-facing strings only through `L("key")` (Design/Localization) using the web's keys
  from `web/src/locales`. Never hardcode English.
- Never hardcode server addresses, account names, user names or IPs. Everything comes
  from the signed-in server.
- Comments explain *why*, short. No essays, no em dashes.

## Report format (your final message)
1. **Done**: what works, file list.
2. **Verified**: exact commands run and their result (build/test output summary).
3. **Not done / stubbed**: honest list, with `TODO` locations.
4. **Requests**: changes you need in lead-owned files, precise (type, field, signature).
5. **Spec issues**: anything in API.md/UI.md that was wrong or missing.
Do not claim something works unless you built and tested it.

## Tests without hangs (screen tasks)
- Each task has its own simulator named `slopify-<task>`. Get its id with
  `xcrun simctl list devices | grep "slopify-<task> "` and pass `SIM=<id>`.
- Run tests in the foreground only, with a kill timer, and only your classes:
  `( sleep 480; pkill -f "derivedDataPath build/dd-<task>" ) & make test DD=build/dd-<task> SIM=<id> ONLY=SlopifyTests/<Class>; kill %1`
- Never end your turn while a build or test runs in the background. If a run hangs, kill it,
  `xcrun simctl shutdown <id>`, and run again once. Still hung: say so in your report.
- Read results with `xcrun xcresulttool get test-results summary --path <newest xcresult>`.

## Names (all features share one module)
- Every helper type you add that is not one of your stub screens must be `private`/`fileprivate`,
  or named with your area prefix (`HomeShelfModel`, `SearchDebouncer`). Same for test fakes
  (`HomeFakeAPI`, not `FakeBackend`). A global name like `ShareSheet` clashes with another task.
- Shared helpers live in Design. `ShareSheet.present(url:title:)` / `present(items:)` exists there now.
