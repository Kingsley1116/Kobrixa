# Installation and recovery

> Status: v1 candidate. USB and Wi-Fi support has not completed the three-platform physical-brick matrix.

## Development build

Install Node.js 24 and pnpm 10.15, run `pnpm install`, then use `pnpm dev`. `pnpm package` creates an unsigned development application for the current operating system.

On Debian/Ubuntu, install the native USB build dependencies before `pnpm install` or packaging:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

### CI and development downloads

The **CI** workflow runs on pull requests, pushes to `main`, and manual dispatches. Common formatting, root-config lint and CI-routing tests run once on Ubuntu. Product checks are selected from the complete Git diff:

- `apps/web/` and `docs/` changes run website type/lint checks, frontend/IR and Worker tests, and the website build.
- `apps/desktop/`, `examples/`, `tests/`, desktop tools and the desktop release workflow run desktop checks, core/desktop tests and packaging on Ubuntu 24.04 x64, Windows 2025 x64 and macOS 26 arm64. Website tests do not run in this matrix.
- Shared packages, language frontends, assets, lockfiles, root configuration and CI tooling run both products. Unknown paths also run both. Root README/contribution/license-only changes run common checks.
- Manual dispatch always runs both. Missing comparison history falls back to both. Renames and deletions include their original paths.

`CI result` keeps the same required-check name. It accepts skipped product jobs only when the change detector explicitly marks them unaffected; failures, cancellations and unexpectedly skipped required jobs fail the gate. New commits cancel older CI runs for the same branch or pull request.

Run `pnpm check:common` for common checks. For the website, run `pnpm check:web`, `pnpm test:web`, then `pnpm build:web`. For the desktop, run `pnpm check:desktop`, `pnpm build:core`, `pnpm test:desktop`, `pnpm build:desktop`, then `pnpm package:archive`. The archive command extracts the result into a temporary directory, verifies the complete file tree, permissions, symlinks and packaged USB modules, then writes a SHA-256 checksum. Native build dependencies remain necessary on each operating system. `pnpm check:ci` and `pnpm test:ci` remain available for full-repository local checks. Desktop tag releases use the common and desktop checks without running website builds/tests.

Regular CI does not upload applications. To download a development build, manually run **CI** with **upload_artifacts** enabled. Archives and checksums are retained for 7 days. Existing Actions storage quota exhaustion can still block these optional uploads; retention changes do not remove old artifacts. Release builds use Release assets directly instead of Actions artifacts.

### Desktop Release drafts

1. Set the same SemVer version in the root and every workspace `package.json`, update the lockfile when needed, and merge the version change into `main`.
2. Push an existing commit's version tag, such as `v0.1.0-v1-candidate.0`. The **Desktop Release** workflow rejects malformed tags, mismatched package versions and commits outside `main` history.
3. The workflow prepares a **建置中 / Building** draft and verifies the exact tagged commit. Each platform uploads its archive and checksum directly to that draft. A prerelease suffix marks the draft as a prerelease.
4. After all checks succeed and all six assets are downloaded and checksum-verified, the draft becomes **待發布 / Ready for manual publication**, with the source commit and generated release notes. Review it and publish manually; the workflow never publishes automatically.

Downloads use `Kobrixa-<version>-win32-x64.zip`, `Kobrixa-<version>-darwin-arm64.zip`, and `Kobrixa-<version>-linux-x64.tar.gz`, each accompanied by `.sha256`. Extract the archive, then launch `kobrixa.exe`, `Kobrixa.app`, or `kobrixa` respectively. These are unsigned development applications; the macOS build is not notarized. Intel Mac, installers, signing and automatic updates are not included.

A failed run leaves an incomplete draft and reports platform results in the workflow summary. Rerun failed jobs for the same tag and commit; only matching draft assets may be replaced. A moved tag, a manually created/unrecognized draft, or an already published Release is rejected. A checksum/finalization failure also leaves the draft unready. Do not publish incomplete drafts or move release tags. Release runs for the same tag are serialized and do not cancel active runs.

No personal access token is required: regular CI has read-only repository permissions, while Release-writing jobs use `GITHUB_TOKEN` with `contents: write`. Website deployment and existing remote artifacts are unchanged. When introducing the workflows, validate the first real draft with the next intended version tag; do not publish a test version just to exercise automation.

To measure the change, compare the first cold-cache run with later warm-cache runs in Actions: record per-job durations, total runner minutes and archive sizes. Compare equivalent commits and runner platforms; there is no fixed speedup guarantee. The workflows cache only the pnpm store by OS, architecture and lockfile, never `node_modules` or compiled native outputs.

The editor and compiler do not require a cloud account or internet connection. Wi-Fi is used only to communicate with an EV3.

## USB

Connect only one EV3 while diagnosing access problems. A permission error is different from “not found.” On Linux, add a narrowly scoped udev rule for LEGO vendor `0694`, EV3 product `0005`; do not grant broad access to every HID device. Reconnect the brick after changing a rule.

## Wi-Fi

The EV3 and computer must be on the same trusted network. Use discovery or enter the brick's IPv4/IPv6 address. Check TCP port 5555 and local firewall rules if connection is refused or times out.

## Recovery

- Cancel a stalled operation and reconnect without restarting Kobrixa.
- A failed or cancelled build preserves the last successful artifact.
- A disconnect during upload is reported as an error; reconnect and upload again.
- Unsaved editor drafts are restored from local application data on the next open.
