# Change Log

History begins at 0.4.0.

## 2026-05-24 — current-activity-status

- Add status-bar items for current activity and elapsed time, refreshed by polling `GET /current` on the Mac app (interval set by `nowdoing.currentPollSeconds`, default 10s).
- Add settings `nowdoing.showCurrentActivity` and `nowdoing.showElapsedTime` (both default `true`) plus matching toggle commands `NowDoing: Toggle Current Activity in Status Bar` / `… Elapsed Time …`. Clicking either status item toggles its visibility.
- Elapsed time is rendered locally (`<1m`, `42m`, `1h 5m`) and ticked every 30s between polls so the value stays fresh without hammering the Mac app.

## 2026-05-24 — more-tests

- Extract pure helpers from `extension.ts` into `src/util.ts` (`parseJson`, `errorMessageFromResponse`, `formatError`, `buildActivitySearchPath`).
- Extract `RepoWatcher` into `src/repoWatcher.ts` behind a narrow `WatchedRepository` interface and an injected `getDebounceMs` so its debounce/dedup behavior is unit-testable.
- Add `src/test/util.test.ts` covering helper edge cases (11 tests).
- Add `src/test/repoWatcher.test.ts` covering initial-branch suppression, debounce coalescing, same-HEAD dedup, detached-HEAD handling, dispose cleanup, and live debounce reconfiguration (7 tests).
- Add `src/test/protocol.test.ts` — end-to-end HMAC round-trip against an in-test `http` server that ports the Swift `BranchChangeServer` verification rules. Covers happy path, querystring-in-canonical, body tampering, stale/missing/malformed timestamps (incl. exact 60s drift boundary), nonce replay/format, signature format/length/case/wrong-token, and empty-body POST (18 tests).
- Test count: 6 → 42.
