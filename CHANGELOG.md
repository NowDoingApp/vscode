# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## 0.8.0 (2026-05-27)


### Features

* snapshot repository ([2eca644](https://github.com/NowDoingApp/vscode/commit/2eca6440a4eee495a7f36f3ca041c71e9b90d647))

## 0.7.0 (2026-05-27)

- Improve status bar actions so clicking the main status entry opens the action menu (`nowdoing.showStatusMenu`).
- Add branch watcher ignore support via `nowdoing.watchIgnorePattern` to suppress prompts for matching branches.
- Improve reliability with in-memory retry/backoff for transient branch-change delivery failures.
- Harden connection checks through authenticated `GET /healthcheck` handling.

## 0.6.0 (2026-05-25)

- Switch transport from `127.0.0.1:<port>` to a Unix-domain socket inside the Mac app's sandbox container. The extension no longer opens any TCP connection.
- Read the socket path and auth token from `~/Library/Containers/com.mattes.nowdoing/Data/api-endpoint.json` (mode `0600`) on every request via a new `src/capability.ts`. Token storage in VS Code SecretStorage is gone; the `nowdoing.apiToken` secret and `nowdoing.tokenConfigured` global-state flag are no longer touched.
- Remove the `NowDoing: Set Token` command and the `nowdoing.port` setting — both obsolete now that the Mac app publishes the endpoint itself.
- Rename the `needs-token` connection state to `needs-app` (capability file missing/unreadable). Status-bar click in that state retries the connection. Lost-connection warning also fires on `connected → needs-app`.
- Add `src/test/capability.test.ts` covering the capability-file reader (8 tests). Test count: 42 → 50.
- Bump to 0.6.0 (breaking: requires the Mac app build that writes the capability file).

## 0.5.0 (2026-05-24)

- Add status-bar items for current activity and elapsed time, refreshed by polling `GET /current` on the Mac app (interval set by `nowdoing.currentPollSeconds`, default 10s).
- Add settings `nowdoing.showCurrentActivity` and `nowdoing.showElapsedTime` (both default `true`) plus matching toggle commands `NowDoing: Toggle Current Activity in Status Bar` / `… Elapsed Time …`. Clicking either status item toggles its visibility.
- Elapsed time is rendered locally (`<1m`, `42m`, `1h 5m`) and ticked every 30s between polls so the value stays fresh without hammering the Mac app.

## 0.4.0 (2026-05-24)

- Extract pure helpers from `extension.ts` into `src/util.ts` (`parseJson`, `errorMessageFromResponse`, `formatError`, `buildActivitySearchPath`).
- Extract `RepoWatcher` into `src/repoWatcher.ts` behind a narrow `WatchedRepository` interface and an injected `getDebounceMs` so its debounce/dedup behavior is unit-testable.
- Add `src/test/util.test.ts` covering helper edge cases (11 tests).
- Add `src/test/repoWatcher.test.ts` covering initial-branch suppression, debounce coalescing, same-HEAD dedup, detached-HEAD handling, dispose cleanup, and live debounce reconfiguration (7 tests).
- Add `src/test/protocol.test.ts` — end-to-end HMAC round-trip against an in-test `http` server that ports the Swift `BranchChangeServer` verification rules. Covers happy path, querystring-in-canonical, body tampering, stale/missing/malformed timestamps (incl. exact 60s drift boundary), nonce replay/format, signature format/length/case/wrong-token, and empty-body POST (18 tests).
- Test count: 6 → 42.
