# Code signing policy

Kobrixa's release workflow supports Apple Developer ID signing and notarization for macOS, and SignPath signing for Windows. Both are disabled until their accounts, credentials and verification are ready. Workflow support does not mean that an existing download is signed: read that version's Release notes and verify the downloaded application.

Windows signing through SignPath Foundation is planned and subject to approval. Kobrixa does not currently claim Foundation sponsorship or an issued certificate. Until approval, Windows builds remain explicitly unsigned. Linux archives remain unsigned and include a SHA-256 checksum. A checksum detects changes but does not authenticate the publisher.

## Responsibilities and privacy

- Author, reviewer and release/signing approver: [Kingsley1116](https://github.com/Kingsley1116). Changes from other contributors require maintainer review. GitHub and SignPath accounts used for signing must have multi-factor authentication enabled.
- The approver reviews the exact source commit, checks and signing request before approving each Windows release. Approval in SignPath and publication of the GitHub Release are separate manual operations.
- The desktop editor/compiler operates locally. EV3 discovery, connections and transfers occur when requested by the user; explicitly opened LEGO links use the system browser. The desktop application does not implement advertising, analytics or automatic update checks. The website and Gallery have their own [privacy policy](https://kobrixa.com/privacy).
- Signing services receive release binaries/build metadata as part of publishing. They do not receive users' local projects through this workflow.

## Release behavior

`MACOS_SIGNING_ENABLED` and `WINDOWS_SIGNING_ENABLED` are GitHub repository **Variables**, accepting only `true`, `false` or an unset value (disabled). The validation job records a signing snapshot used by all later jobs and in the draft's ownership marker. A failed-job rerun keeps the original snapshot; a rerun of all jobs with different modes cannot overwrite that draft. Change modes on a new version tag, not an existing draft/tag.

Only validated tags on `main` history can use release signing. Common checks and desktop tests must pass first. Pull requests, ordinary CI and `pnpm package` do not need signing credentials. Enabling a platform requires all of its configuration: missing credentials, rejected/expired certificates, failed notarization, invalid signatures, a rejected signing request or a timeout fail that platform. There is no automatic unsigned fallback.

The workflow still creates three archives and three SHA-256 files, leaving a draft for manual publication. Signed applications are verified before archiving and again after extraction. Pending/incomplete drafts describe signing as unverified; only a successful finalized draft claims verification.

## Publication review

Before the first public release, the maintainer must review the exact commit and draft:

1. Inspect tracked files and reachable Git history for credentials and private data. Check the final archives too; ignoring a file does not remove it from history or old artifacts.
2. Confirm redistribution rights for source, examples and media. Check the packaged project `LICENSE`, `THIRD-PARTY-NOTICES.txt` and upstream Electron/Chromium/HIDAPI notices.
3. Complete production macOS signing/notarization and browser-download verification. Record the outstanding platform and EV3 acceptance results using the [device support checklist](../en/device-support.md).
4. Confirm that the draft contains exactly three archives and three matching SHA-256 files, uses the intended commit and signing modes, and reports each platform accurately.
5. Make the repository public and publish the Release as separate manual operations. Keep Windows explicitly unsigned until SignPath approval; account verification, payment, application and signing approvals remain the owner's responsibility.

## Set up macOS

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/) and complete identity verification/payment yourself. Create a **Developer ID Application** certificate with its private key and export it as a password-protected P12. An Apple Development or Developer ID Installer certificate is not a substitute.
2. In GitHub → Settings → Secrets and variables → Actions, set the following. Never paste keys or passwords into an issue, chat or committed file.

| Kind     | Name                           | Value                                                             |
| -------- | ------------------------------ | ----------------------------------------------------------------- |
| Secret   | `MACOS_CERTIFICATE_P12_BASE64` | Single-line base64 of the exported P12, including its private key |
| Secret   | `MACOS_CERTIFICATE_PASSWORD`   | P12 export password                                               |
| Secret   | `APPLE_ID`                     | Apple account used for notarization                               |
| Secret   | `APPLE_APP_SPECIFIC_PASSWORD`  | App-specific password, not the account login password             |
| Variable | `APPLE_TEAM_ID`                | Ten-character Apple Team ID                                       |
| Variable | `MACOS_SIGNING_IDENTITY`       | Full `Developer ID Application: Name (TEAMID)` identity           |
| Variable | `MACOS_SIGNING_ENABLED`        | Set to `true` when the above are ready                            |

The macOS runner imports the certificate into a temporary keychain. Its path is supplied to Forge, and the original keychain search list is restored during cleanup, including failed builds. The P12 and temporary keychain are removed. Cancellation relies on the runner executing `always()` cleanup; disposal of the hosted runner is the final cleanup boundary for a forced termination.

Forge signs `com.kobrixa.ide`, its helpers and native modules with Hardened Runtime, then submits to Apple's notary service and staples the ticket. The entitlements enable JIT and USB; they do not disable library validation. The archive is created only after successful verification. Only the target's `node-hid` prebuilds are included.

## Set up Windows after public release and SignPath approval

1. Finish the [publication review](#publication-review), make the repository public yourself, and publish a usable release. The first Windows release can be unsigned. Submit the project to [SignPath Foundation](https://signpath.org/apply.html); acceptance is discretionary and may require an established reputation.
2. Have SignPath approve the Electron-based `kobrixa.exe` signing scope. Do not independently sign upstream DLLs or `node-hid` binaries with the Foundation certificate. If this scope is not accepted, leave Windows signing disabled and report the requirement; do not broaden the scope automatically.
3. Link the project to the GitHub trusted build system and grant the SignPath GitHub App the required repository access. Configure the approved production signing policy for human approval, GitHub-hosted builds and this repository/release workflow. A test certificate must not be used for a production release.
4. Import [`tools/release/signpath-artifact.xml`](https://github.com/Kingsley1116/Kobrixa/blob/main/tools/release/signpath-artifact.xml) as the artifact configuration. It signs only the root `kobrixa.exe` inside the uploaded ZIP, requires Kobrixa product metadata and the build's numeric version, and requests SHA-256 Authenticode. Require a trusted RFC 3161 timestamp in the service policy. Preserve all other files. Windows PE versions use `major.minor.patch.0`; the full SemVer remains in the package and archive name.
5. Set these GitHub settings, then enable the Windows switch on the next release tag.

| Kind     | Name                                   | Value                                                              |
| -------- | -------------------------------------- | ------------------------------------------------------------------ |
| Secret   | `SIGNPATH_API_TOKEN`                   | Submitter token for the approved project/policy                    |
| Variable | `SIGNPATH_ORGANIZATION_ID`             | Assigned organization ID                                           |
| Variable | `SIGNPATH_PROJECT_SLUG`                | Assigned project slug                                              |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG`         | Approved production policy slug                                    |
| Variable | `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` | Configuration containing the checked-in XML                        |
| Variable | `SIGNPATH_CERTIFICATE_SUBJECT`         | Exact certificate Subject from the approved production certificate |
| Variable | `WINDOWS_SIGNING_ENABLED`              | `true` only after approval and configuration                       |

The workflow uploads the unsigned application as a separate Actions artifact retained for one day. This requires available Actions storage quota; shortening retention does not remove older artifacts or instantly reclaim quota. Final downloads still go directly to Release assets. The signing request waits up to 60 minutes for human approval; rejection, timeout or service failure leaves an incomplete draft. Inspect the request link in the SignPath step logs before rerunning the same commit; a rerun submits a new request, and old pending requests should be cancelled in SignPath. Do not publish or reuse an unsigned temporary artifact as a signed release.

The returned application must have exactly the original file set and unchanged contents except `kobrixa.exe`. Windows validates its Authenticode trust, expected certificate subject, timestamp and product/version metadata before replacement. New signed files may still display SmartScreen reputation warnings.

Once Foundation approval is confirmed, update this policy and its Traditional Chinese counterpart with the following attribution, linked to both organizations: “Free code signing provided by SignPath.io, certificate by SignPath Foundation”. The release tool adds this attribution to successfully verified Windows-signed releases only. Until then, keep the pending wording above.

## Acceptance and renewal

- Run the common and desktop checks, release tests, and packaging on each supported runner. macOS must pass `codesign --verify --deep --strict`, expected identity/Team ID checks, `xcrun stapler validate` and `spctl --assess --type execute` on the extracted application. Windows must pass the checked-in PowerShell verifier and Windows SDK SignTool checks.
- Download the release through a browser on a clean machine, then check launch, sample compilation and EV3 USB/Wi-Fi operations. Record OS/version, artifact checksum and results in the release checklist. A local build without browser quarantine does not complete Gatekeeper acceptance.
- Run real signed acceptance only with approved production credentials. Without them, mocked tests and unsigned packaging verify the integration, not Apple/SignPath issuance or end-user trust.
- Before certificate expiry or revocation, replace credentials and confirm the expected identity/subject, then verify a new release. Do not alter already published assets or move tags. If SignPath approval is delayed or declined, keep Windows disabled; there is no automatic paid-provider fallback.

References: [Electron Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos), [SignPath GitHub integration](https://docs.signpath.io/trusted-build-systems/github), [Foundation terms](https://signpath.org/terms.html), [Microsoft signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options).
