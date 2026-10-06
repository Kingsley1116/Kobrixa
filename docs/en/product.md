# Product specification

## Purpose

Kobrixa IDE gives students and makers a dependable, understandable path from EV3 source code to a running robot. The product favors a short feedback loop, actionable errors, offline use, and predictable physical-device behavior over a broad collection of partially supported features.

The current v1 candidate implements Basic Plus editing and compilation, project management, USB/Wi-Fi transports and remote file management. Full platform support still depends on the physical-brick acceptance matrix. Release signing is integrated but requires production credentials and external verification before a download can be described as signed.

## Primary users

- A student learning text-based robotics after block programming.
- A maker maintaining or extending an existing `.bp` robot program.
- A mentor who needs examples and repeatable setup across Windows, macOS, and Linux.

Advanced language tooling, classroom fleet management, and cloud collaboration are not v1 priorities.

## v1 user journey

1. Create a project or open a compatible `.bp` program.
2. Edit with syntax highlighting, completion for supported EV3 APIs, and inline diagnostics; read bilingual explanations and select an applicable Quick Fix.
3. Build locally into a native `.rbf` artifact.
4. Discover and connect to an EV3 over USB HID or Wi-Fi.
5. Upload, run, stop, or remove the program.
6. See a structured result for every operation, including recovery guidance on failure.

The editor and compiler must work offline. Wi-Fi is used for communication with a brick, not as a cloud dependency.

## v1 requirements

### Workspace and editor

- Open a folder, a `kobrixa.json` project, or a standalone `.bp` file.
- Edit multiple project files without losing unsaved work.
- Switch between project tabs while retaining file tabs, drafts, cursor and scroll positions, and undo history for the current app session. Arrow keys and Home/End navigate the project tab strip.
- Edit other projects during a build or upload while EV3 operations remain serialized. Closing a project offers save, discard and cancel; quitting retains the session so projects and drafts reopen automatically.
- Provide syntax highlighting, bracket matching, go-to-diagnostic, basic completion, and formatting for supported `.bp` syntax.
- Show build and device status without hiding detailed diagnostics.
- Explain every diagnostic code offline in English and Traditional Chinese, including causes, repair steps and the original message. The online [diagnostic index](/docs/diagnostics?lang=en) provides code-based lookup.
- Offer Quick Fix for unambiguous syntax gaps: an array-type `]`, a line-ending `)`, `For` `=` or `To`, and unfinished blocks at the end of a file. Apply only after explicit selection, with one-step Undo and normal draft/saving preferences. Ambiguous or stale diagnostics do not directly modify code.

[Keyboard shortcuts and settings](keyboard-settings.md)

### Build

Desktop compilation runs in a dedicated worker, with progress and cooperative cancellation available while the main process handles device and window events.

- Validate the manifest before compiling.
- Compile supported `.bp`, include, module, and asset inputs into `KobrixaIR` and then native `.rbf`.
- Return deterministic diagnostics with stable codes and source ranges.
- Never emit a successful deployable artifact after a compile error.
- Support cancellation; a cancelled build must not replace the last successful artifact.

### Device operations

- Discover USB EV3 devices and connect to a user-supplied Wi-Fi address.
- Display the active transport and connection state.
- Upload, run, stop, and delete a program. Deployment skips assets only when a fresh EV3 directory listing matches their size and checksum; the executable is always uploaded last. Disable “Skip unchanged assets” in Settings → EV3 & execution for a full upload.
- Browse remote files, transfer files or folders, and preview conflicts before batch transfers.
- Time out stalled operations and distinguish permission, discovery, connection, protocol, transfer, and device errors.

### Desktop distribution

- Package Windows x64 NSIS/ZIP, macOS Apple Silicon DMG and Linux x64 AppImage/tar.gz, with update metadata and SHA256SUMS.txt.
- Use Apple Developer ID signing and notarization for enabled macOS releases. Windows remains explicitly unsigned until SignPath Foundation approval and successful signature verification.
- Report each platform's actual signing status in its Release notes. An enabled signing failure leaves an incomplete draft for review.
- Keep Release publication manual. Installers and automatic updates are implemented; available downloads and signing status are determined by each published Release. Intel Mac packages remain outside the current scope.

See [installation and recovery](../en/installation.md) and the [code signing policy](../en/code-signing.md) for downloads and verification.

## Non-goals for v1

- Bluetooth transport
- Blockly or another block editor
- Cloud accounts, synchronization, or collaboration
- A source-level debugger or simulator
- Python, TypeScript, or C++ compilation
- Classroom fleet management
- Importing proprietary project formats beyond supported `.bp` source files

## Success criteria

v1 is acceptable when all of the following are true:

- A supported legacy `.bp` program opens without source modification, compiles, and exhibits equivalent observable behavior on a reference EV3.
- A valid sample builds into `.rbf` on Windows, macOS, and Linux.
- USB and Wi-Fi upload/run workflows pass on all three platforms.
- Syntax and semantic failures identify the source file and line/column range.
- Disconnecting a brick during upload produces a recoverable error and no false success state.
- The application can be installed and used without a cloud account or continuous internet access.
- Final downloads preserve their files, permissions, symlinks and native USB modules, and every advertised signature or notarization passes validation after extraction.

Compatibility is behavioral, not byte-for-byte output equivalence. See the [language support policy](../en/language-support.md) and [device support specification](../en/device-support.md).
