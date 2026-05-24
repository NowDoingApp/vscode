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

Requires the NowDoing macOS app. The extension talks to a local HTTP
listener inside the app and never sends data over the network.

## Features

- Branch-aware prompts. Switching branches in any open repository triggers a
  NowDoing prompt, debounced to avoid spam during rebases.
- Start activities from the palette via `NowDoing: Start Activity` with
  type-ahead search and create-if-missing.
- Status-bar item shows whether NowDoing is reachable; click to retry.
- Loopback only. All traffic goes to `127.0.0.1` and is signed with HMAC
  plus timestamp and nonce.

## How it works

The extension listens to the built-in `vscode.git` API for branch changes.
After a short debounce window (default 1.5 s) it `POST`s to a local HTTP
listener inside the NowDoing app:

```http
POST http://127.0.0.1:39847/branch-changed
X-NowDoing-Token: <shared secret>
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

The listener binds only to `127.0.0.1`, authenticates every request, and
rejects replays via timestamp and nonce checks.

## Setup

1. In the NowDoing macOS app, open *Einstellungen > Integrationen > VSCode*:
    - Enable the integration.
    - Generate a token and copy it.
    - Note the configured port (default `39847`).
2. In VS Code:
    - Install this extension from the Marketplace.
    - Run *NowDoing: Set Token* and paste the token.
    - If you changed the port in NowDoing, set `nowdoing.port` in
      *Settings > Extensions > NowDoing*.
3. Run *NowDoing: Test Connection*. The status bar should switch to
   `✓ NowDoing`.

## Commands

| Command                     | What it does                                           |
| --------------------------- | ------------------------------------------------------ |
| `NowDoing: Set Token`       | Store the shared secret in VS Code SecretStorage.      |
| `NowDoing: Test Connection` | Ping NowDoing's `/healthcheck` endpoint.               |
| `NowDoing: Reconnect`       | Re-check the connection and surface errors.            |
| `NowDoing: Start Activity`  | Search activities and start one (creates on demand).   |
| `NowDoing: Show Output Log` | Reveal the extension's output channel for diagnostics. |
| `NowDoing: Open Settings`   | Jump straight to the extension's settings.             |

## Configuration

| Setting               | Default | Description                                                  |
| --------------------- | ------- | ------------------------------------------------------------ |
| `nowdoing.enabled`    | `true`  | Master switch for branch-change notifications.               |
| `nowdoing.port`       | `39847` | Must match the port set in NowDoing.                         |
| `nowdoing.debounceMs` | `1500`  | Quiet window after a branch change before notifying NowDoing.|

Token storage uses VS Code SecretStorage under the key `nowdoing.apiToken`.

## Token & clock

- The token is used directly as the HMAC-SHA256 key. Generate it from
  NowDoing, don't type a passphrase.
- Requests carry a Unix timestamp. NowDoing rejects requests with more than
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

## License

[MIT](LICENSE) © NowDoing
