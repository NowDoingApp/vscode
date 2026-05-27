<p align="center">
  <img src="images/icon.png" width="128" alt="NowDoing icon" />
</p>

<h1 align="center">NowDoing for VS Code</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=NowDoing.nowdoing-vscode"><img alt="Marketplace Version" src="https://img.shields.io/visual-studio-marketplace/v/NowDoing.nowdoing-vscode.svg?label=Marketplace" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=NowDoing.nowdoing-vscode"><img alt="Marketplace Installs" src="https://img.shields.io/visual-studio-marketplace/i/NowDoing.nowdoing-vscode.svg" /></a>
  <a href="https://github.com/NowDoingApp/vscode/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/NowDoingApp/vscode?label=release" /></a>
  <a href="https://github.com/NowDoingApp/vscode/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/NowDoingApp/vscode/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
  <a href="https://github.com/NowDoingApp/vscode/actions/workflows/release.yml"><img alt="Release" src="https://github.com/NowDoingApp/vscode/actions/workflows/release.yml/badge.svg" /></a>
  <a href="https://nowdoing.app"><img alt="Website" src="https://img.shields.io/badge/website-nowdoing.app-1F1F23" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
</p>

Notifies the [NowDoing](https://nowdoing.app) macOS app when you switch Git
branches in VS Code, so NowDoing can pop up its time-entry prompt. You can
also start activities directly from the command palette.

Requires the NowDoing macOS app. The extension talks to a Unix-domain
socket inside the app's sandbox container and never sends data over the
network.

## Features

- Branch-aware prompts. Switching branches in any open repository triggers a
  NowDoing prompt, debounced to avoid spam during rebases.
- Start activities from the palette via `NowDoing: Start Activity` with
  type-ahead search and create-if-missing.
- Live status-bar readout of the currently tracked activity and elapsed time
  (visibility is controlled via settings).
- Clicking the activity item or elapsed item opens `Track New Activity`.
- Clicking the main status-bar item opens an action menu (track, test,
  reconnect, settings, logs).
- No network port. All traffic goes through a Unix-domain socket inside the
  NowDoing sandbox container and is signed with HMAC plus timestamp and nonce.

## How it works

The extension listens to the built-in `vscode.git` API for branch changes.
After a short debounce window (default 1.5 s) it `POST`s to a local
Unix-domain socket inside the NowDoing app's sandbox container:

```http
POST /branch-changed                       (via UDS, no TCP)
X-NowDoing-Token: <from capability file>
X-NowDoing-Timestamp: <unix-seconds>
X-NowDoing-Nonce: <random-hex>
X-NowDoing-Signature: <hmac-sha256>
Content-Type: application/json

{"repo": "NowDoing", "repoPath": "/Users/me/dev/NowDoing",
 "branch": "feat/auth", "previousBranch": "main"}
```

NowDoing opens its prompt popover with the new branch name. A separate
`GET /healthcheck` endpoint is used for reachability checks and never
triggers a prompt.

When the integration is enabled, the Mac app writes a capability file
to `~/Library/Containers/com.mattes.nowdoing/Data/api-endpoint.json`
(mode `0600`) containing the current socket path, auth token, and PID.
The extension reads that file on every request — there is no port to
configure and no token to paste.

## Setup

1. In the NowDoing macOS app, open _Einstellungen > Integrationen > VSCode_
   and enable the integration. The app writes the capability file
   automatically.
2. In VS Code, install this extension from the Marketplace.
3. Run _NowDoing: Test Connection_. The status bar should switch to
   `✓ NowDoing`.

## Commands

| Command                                           | What it does                                           |
| ------------------------------------------------- | ------------------------------------------------------ |
| `NowDoing: Test Connection`                       | Ping NowDoing's `/healthcheck` endpoint.               |
| `NowDoing: Reconnect`                             | Re-check the connection and surface errors.            |
| `NowDoing: Start Activity`                        | Search activities and start one (creates on demand).   |
| `NowDoing: Open Action Menu`                      | Open the same action menu as the status bar click.     |
| `NowDoing: Show Output Log`                       | Reveal the extension's output channel for diagnostics. |
| `NowDoing: Open Settings`                         | Jump straight to the extension's settings.             |
| `NowDoing: Toggle Current Activity in Status Bar` | Show/hide the activity item.                           |
| `NowDoing: Toggle Elapsed Time in Status Bar`     | Show/hide the elapsed-time item.                       |

## Status Bar Actions

Clicking the main `NowDoing` status entry opens a context menu with:

- Track New Activity
- Test Connection
- Reconnect
- Open Settings
- Show Output Log

Clicking either secondary status item (activity name or elapsed time)
opens `Track New Activity`.

## Delivery Reliability

When branch-change delivery fails with transient conditions (`429`, `503`,
timeout, or connection resets), notifications are queued in memory and retried
with exponential backoff.

## Configuration

| Setting                        | Default | Description                                                   |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| `nowdoing.enabled`             | `true`  | Master switch for branch-change notifications.                |
| `nowdoing.debounceMs`          | `1500`  | Quiet window after a branch change before notifying NowDoing. |
| `nowdoing.watchIgnorePattern`  | `""`    | Optional regex. Matching target branches are ignored.         |
| `nowdoing.showCurrentActivity` | `true`  | Show current activity in the status bar.                      |
| `nowdoing.showElapsedTime`     | `true`  | Show elapsed time on the current activity in the status bar.  |
| `nowdoing.currentPollSeconds`  | `10`    | How often to refresh the current activity from NowDoing.      |

If `nowdoing.watchIgnorePattern` contains an invalid regular expression,
the extension logs a warning and ignores the setting until fixed.

The auth token lives only in the capability file the Mac app writes
(mode `0600`, same-UID-only) — it is not stored in VS Code settings or
SecretStorage.

## Clock skew

Requests carry a Unix timestamp. NowDoing rejects requests with more than
60 seconds of drift. If you see "expired timestamp" or "signature invalid"
errors, check the system clock (NTP).

## Privacy

The extension transmits the repository folder basename, the absolute
repository path, the new branch name, and the previous branch name to the
local NowDoing listener. No data leaves your machine.

## Build from source

```sh
git clone https://github.com/NowDoingApp/vscode.git nowdoing-vscode
cd nowdoing-vscode
npm install
npm run bundle      # esbuild -> dist/extension.js
npm test            # tsc -> out/, then node --test
# Press F5 in VS Code to launch an Extension Development Host.
```

`npm run watch` rebuilds the bundle on save during development.
`npm run typecheck` runs the TypeScript compiler in no-emit mode.
Test artifacts go to `out/` so `dist/` only contains the shipped bundle.

To produce a `.vsix` for sideloading:

```sh
npm run package
```

## Release flow

Release preparation is driven from Conventional Commits.

```sh
# inspect the next generated release without changing files
npm run release:dry-run

# prepare the next release files locally
npm run release:patch
# or
npm run release:minor
# or
npm run release:major

# validate the prepared release
npm run release:check
```

`npm run release:patch`, `npm run release:minor`, and `npm run release:major` update `package.json`, `package-lock.json`, and prepend a generated entry to `CHANGELOG.md` without creating a commit or tag.

After review, commit the prepared release change and push it to `main` only when it is actually ready to ship. The manual GitHub release workflow then:

- reads the version from `package.json`
- verifies the tag does not already exist
- runs typecheck, tests, and bundle creation
- packages the `.vsix`
- reads the newest section from `CHANGELOG.md`
- uses that changelog section as the GitHub Release notes
- creates and pushes the matching `v<version>` tag

This keeps the local changelog and the GitHub release page in sync.

## License

[MIT](LICENSE) © NowDoing 2026
