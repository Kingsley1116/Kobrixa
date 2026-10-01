# Installation and recovery

## Release downloads

Choose a published version from [GitHub Releases](https://github.com/Kingsley1116/Kobrixa/releases), then download and install the file for your operating system below. All future desktop releases include the updater, available in Settings → Updates after installation. A building or incomplete draft is not ready for installation.

| Platform            | Download                                | Installation                                                 |
| ------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Windows x64         | `Kobrixa-<version>-win32-x64-setup.exe` | Run the installer to install for the current user            |
| macOS Apple Silicon | `Kobrixa-<version>-darwin-arm64.dmg`    | Open the DMG and drag `Kobrixa.app` into Applications        |
| Linux x64           | `Kobrixa-<version>-linux-x64.AppImage`  | Save to a user-writable location, make executable and launch |

`<version>` is the downloaded version number. Keep projects outside the application directory. Unsigned Windows installers may display system warnings; read the release's per-platform signing status and the [code signing policy](../en/code-signing.md). Physical USB/Wi-Fi acceptance is documented in [device support](../en/device-support.md).

### SHA-256 verification (optional)

SHA-256 verification is optional and is not required to install or use Kobrixa. To check that a download is intact, also download its matching `.sha256` file into the same directory. Replace `<version>` in these examples with the downloaded version.

In PowerShell on Windows, compare the computed hash with the first field of the checksum file:

```powershell
Get-FileHash -Algorithm SHA256 'Kobrixa-<version>-win32-x64-setup.exe'
Get-Content 'Kobrixa-<version>-win32-x64-setup.exe.sha256'
```

On macOS:

```sh
shasum -a 256 -c 'Kobrixa-<version>-darwin-arm64.dmg.sha256'
```

On Linux:

```sh
sha256sum -c 'Kobrixa-<version>-linux-x64.AppImage.sha256'
```

Checksums confirm that a download matches the release file; code signatures establish publisher identity. This optional step concerns manual verification of your download. The updater still verifies the updates it downloads automatically.

## Automatic updates

Windows installations and Linux AppImages can download updates automatically and install after confirmation. Automatic installation on macOS requires valid Apple signatures on both the installed and target versions. Unsigned macOS builds notify you of new releases and provide the download page; update using the installation steps above.

Settings → Updates shows the installed version, progress and check results. Background checks run 30 seconds after startup and every six hours. Stable releases are the default. You can disable background checks or opt into preview releases, including `v1-candidate`. Switching back to stable never downgrades your app. When no stable release exists, the settings page explains that preview updates are optional. “Check for updates” still downloads an available update when background checks are disabled.

Choose “Later” to keep working. Normal exit never installs an update; “Restart and update” starts installation. Unsaved work requires “Save all and update”; failed saves retain drafts and cancel installation. Builds, device transfers and project/device file operations block update installation. Reopen the project after restarting; the existing settings and draft storage location is retained.

The source is this repository's public GitHub Releases, with no embedded access token. Private or offline sources show an unavailable status without affecting editing. Downloads require public, complete releases. Retry download/verification failures; if installation does not complete, reinstall from Releases without deleting projects or user data. Development mode does not check for updates.

## Development build

Install Node.js 24 and the repository-pinned pnpm 10.15.0, run `pnpm install --frozen-lockfile`, then use `pnpm dev`. `pnpm package` creates an unsigned development application for the current operating system; no Apple or SignPath credentials are required.

On Debian/Ubuntu, install the native USB build dependencies before `pnpm install` or packaging:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

### CI and development downloads

The **CI** workflow runs on pull requests, pushes to `main`, and manual dispatches. Common formatting, root-config lint and CI-routing tests run once on Ubuntu. Product checks are selected from the complete Git diff:

- `apps/web/` and `docs/` changes run website type/lint checks, frontend/IR and Worker tests, and the website build.
- `apps/desktop/`, `examples/`, `tests/`, desktop tools and the desktop release workflow run desktop checks, core/desktop tests and packaging on Ubuntu 24.04 x64, Windows Server 2022 x64 (Visual Studio 2022) and macOS 26 arm64. Website tests do not run in this matrix.
- Shared packages, language frontends, assets, lockfiles, root configuration and CI tooling run both products. Unknown paths also run both. Root README/contribution/license-only changes run common checks.
- Manual dispatch always runs both. Missing comparison history falls back to both. Renames and deletions include their original paths.

`CI result` keeps the same required-check name. It accepts skipped product jobs only when the change detector explicitly marks them unaffected; failures, cancellations and unexpectedly skipped required jobs fail the gate. New commits cancel older CI runs for the same branch or pull request.

Run `pnpm check:common` for common checks. For the website, run `pnpm check:web`, `pnpm test:web`, then `pnpm build:web`. For the desktop, run `pnpm check:desktop`, `pnpm build:core`, `pnpm test:desktop`, `pnpm build:desktop`, `pnpm test:desktop:packaged`, `pnpm package:installers`, `pnpm package:archive`, then `pnpm package:updates`. The archive command extracts the result into a temporary directory, verifies the complete file tree, permissions, symlinks and packaged USB modules, then writes a SHA-256 checksum. Native build dependencies remain necessary on each operating system. `pnpm check:ci` and `pnpm test:ci` remain available for full-repository local checks. Desktop tag releases use the common and desktop checks without running website builds/tests.

Regular CI does not upload applications. To download a development build, manually run **CI** with **upload_artifacts** enabled. Archives and checksums are retained for 7 days. Existing Actions storage quota exhaustion can still block these optional uploads; retention changes do not remove old artifacts. Final Release downloads use Release assets directly. Enabled Windows signing additionally requires a temporary Actions artifact retained for one day.

### Desktop Release drafts

1. Set the same SemVer version in the root and every workspace `package.json`, update the lockfile when needed, and merge the version change into `main`.
2. Push an existing commit's version tag, such as `v0.1.0-v1-candidate.0`. The **Desktop Release** workflow rejects malformed tags, mismatched package versions and commits outside `main` history.
3. The workflow prepares a **建置中 / Building** draft and verifies the exact tagged commit. Each platform uploads its archive and checksum directly to that draft. A prerelease suffix marks the draft as a prerelease.
4. After all checks succeed and all archives, installers and update metadata are downloaded and verified, the draft becomes **待發布 / Ready for manual publication**, with the source commit and generated release notes. Review it and publish manually; the workflow never publishes automatically.

Final assets include the three original archives, a Windows NSIS installer, Linux AppImage, macOS DMG and update ZIP, and a `.sha256` for each download. Windows/Linux update metadata is included; only signed macOS releases advertise `latest-mac.yml`. Signing defaults off. Enabled macOS releases require Developer ID signing and notarization; enabled Windows releases require an approved SignPath signature and timestamp. Linux remains unsigned. Intel Mac packages are not included. Packaged license notices, native modules, file contents, symlinks and executable permissions are checked before and after archiving; enabled signatures are verified at both stages. See the [code signing policy](../en/code-signing.md) for credentials, approval and privacy details.

Prepare Apple credentials first and publish the initial Windows version as explicitly unsigned. After the repository and a usable release are public, apply to SignPath Foundation and enable Windows signing only after approval. Enabled signing failures never fall back to unsigned artifacts. A signing request rejected or not approved within 60 minutes leaves an incomplete draft. The draft records its signing modes; reruns cannot mix different modes under the same tag.

A failed run leaves an incomplete draft and reports platform results in the workflow summary. Rerun failed jobs for the same tag and commit; only matching draft assets may be replaced. A moved tag, a manually created/unrecognized draft, or an already published Release is rejected. A checksum/finalization failure also leaves the draft unready. Do not publish incomplete drafts or move release tags. Release runs for the same tag are serialized and do not cancel active runs.

No GitHub personal access token is required: regular CI has read-only repository permissions, while Release-writing jobs use `GITHUB_TOKEN` with `contents: write`. Enabled signing separately requires Apple credentials or a SignPath API token. Repository visibility and Release publication remain manual operations. Validate the first real draft with the next intended version tag; do not publish a test version just to exercise automation.

To measure the change, compare the first cold-cache run with later warm-cache runs in Actions: record per-job durations, total runner minutes and archive sizes. Compare equivalent commits and runner platforms; there is no fixed speedup guarantee. The workflows cache only the pnpm store by OS, architecture and lockfile, never `node_modules` or compiled native outputs.

The editor and compiler do not require a cloud account or internet connection. Automatic updates contact GitHub and can be disabled in Settings → Updates. EV3 Wi-Fi traffic remains on the local network.

## USB

Connect only one EV3 while diagnosing access problems. A permission error is different from “not found.” On Linux, add a narrowly scoped udev rule for LEGO vendor `0694`, EV3 product `0005`; do not grant broad access to every HID device. Reconnect the brick after changing a rule.

## Wi-Fi

The EV3 and computer must be on the same trusted network. Discovery listens for IPv4 UDP advertisements on port 3015; you can also enter the brick's address directly. Connections use TCP port 5555. Check these ports and local firewall rules if discovery is empty or connection is refused or times out.

## Recovery

- Cancel a stalled operation and reconnect without restarting Kobrixa.
- A compile error or cancellation before output commit preserves previous output. Files commit individually; after a commit-stage failure, rebuild successfully before deploying.
- A disconnect during upload is reported as an error and can leave a partial file on the EV3; reconnect, inspect the destination and upload again.
- Unsaved editor drafts are restored from local application data on the next open.
