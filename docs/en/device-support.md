# Device and platform support

## Historical v1 support matrix (2026-10-12)

| Desktop target      | USB HID                | Wi-Fi                  | Bluetooth       |
| ------------------- | ---------------------- | ---------------------- | --------------- |
| Windows x64         | Accepted by maintainer | Accepted by maintainer | Not implemented |
| macOS Apple Silicon | Accepted by maintainer | Accepted by maintainer | Not implemented |
| Linux x64           | Accepted by maintainer | Accepted by maintainer | Not implemented |

Support is not considered shipped until automated transport tests and physical reference-brick tests pass on that platform.

The shared USB and Wi-Fi transports already exist in `packages/device`. The maintainer confirmed physical EV3 acceptance on 2026-10-12. This records that confirmation; detailed platform logs are not attached here. Record the operating system, firmware, transport, exact application version and observed results for each acceptance run. Desktop signature validity is checked separately under the [code signing policy](../en/code-signing.md).

## Stage 3 development interface

On the Stage 3 development branch, use **Plugin tools → EV3 device** for explicit discovery, connection and monitoring, and the contributed plugin settings for connection preferences. Opening the panel does not connect. Switching USB/Wi-Fi saves the choice immediately; remembering a Wi-Fi address still requires opt-in and a successful connection. A preference-save failure after connection does not disconnect or repeat the connection.

Core build/deploy, version checks, remote files and pending-Run Cancel continue to use the same session. Disconnect is a host action that stops and saves first. Closing a device panel removes only its observation demand; another active recorder remains responsible for its recording. Reconnection does not revive cancelled Run or recording intent.

The v1 platform confirmations above do not certify this migration. Stage 3 native/installed and physical acceptance remains open in the [device UI checklist](../../tests/hardware/device-ui.md). The legacy device monitor and connection-settings renderer UI has been retired on this branch. The renderer routes to Plugin tools, and core battery status retains one host-backed path. Retirement of obsolete main IPC, preload and shared contracts is still in progress; final native retirement evidence remains open. Motor and Lab private routes are already removed. S3-13–S3-15 remain **NOT RUN**; the historical matrix is not Stage 3 platform approval.

## USB

- Discover supported EV3 USB HID devices without scanning unrelated interfaces.
- Report missing permissions or driver access separately from “device not found.”
- Use bounded reads and writes, validate packet lengths, and reject malformed replies.
- Close handles on cancellation, disconnect, application exit, and error.
- Provide platform-specific setup guidance only when required; Linux permission guidance must use narrowly scoped device rules.

## Wi-Fi

- Connect to a user-supplied address or a discovered compatible endpoint. Discovery currently listens for IPv4 UDP advertisements on port 3015; manually entered addresses are passed to the TCP client.
- Use the EV3-compatible TCP protocol and validate its handshake before creating a session.
- Apply connect, read, write, and overall operation timeouts.
- Treat an unexpected disconnect as recoverable and never report an incomplete upload as successful.
- Open an outgoing TCP connection to the EV3 on port 5555. Discovery briefly binds a UDP listener; the application does not expose a remote device-control server.

## Operation behavior

Discovery is read-only. Upload, run, stop, and delete require an explicit user action. The UI shows `disconnected`, `connecting`, `connected`, `busy`, or `error` and identifies the active transport.

Upload streams directly to the selected remote path and verifies the transferred length and firmware replies. It does not provide an atomic replacement of an existing remote file. Cancellation or a disconnect can leave a partial remote file; reconnect, inspect the destination and upload again. The transfer handle is closed when possible.

**Run on EV3** saves and builds first, then confirms that the previous user program has stopped before uploading. Starting a program (including **Run uploaded version**) stops the user slot, checks image loading and waits for a firmware startup acknowledgement. The activity log distinguishes upload completion from confirmed startup. A short program may already have finished by the time its acknowledgement arrives; this is not a startup failure. A failed or interrupted start is never retried automatically. Upload-only and USB reconnection do not start a program.

The remote file browser also supports directory listing, downloads, folder creation, rename and deletion. Batch transfers preview conflicts before execution. Local downloads use a temporary file and commit only after a complete transfer; remote rename uses copy/verification/delete behavior because the EV3 firmware does not provide an atomic rename.

Remote paths are normalized as EV3 paths. Parent traversal, embedded nulls, invalid lengths, and unsupported names are rejected before transport I/O.

## Live monitor behavior and retained baseline

For current Stage 3 use **Plugin tools → EV3 device** after connecting over USB or Wi-Fi. The former **EV3 tools → Monitor** destination now directs users to Plugin tools on this branch. The following behavior remains the parity baseline; final replacement acceptance is still open. The panel shows local input ports 1–4, output ports A–D, battery percentage and voltage, and the EV3 user-program slot status. That status describes the program on the brick; it does not identify the currently edited project. Motor angles are read without resetting their counters.

Without an active recording, sampling runs only while the device monitor view is selected, the tools panel is open, and the window is visible. An active recording keeps the same main-process scheduler running in the background. Each completed sample is followed by a 500 ms delay. Foreground operations take priority and there is at most one outstanding sample; uploads, file batches and confirmation waits pause monitoring. Paused, busy or failed samples preserve the last values and mark them as no longer live. The timestamp is the last successful sample, not a promise of continuous updates. Empty ports, initializing devices, unknown devices and unavailable values are distinct; invalid readings are never shown as zero.

Official EV3 UART sensors offer the firmware's Port View modes through **Change mode**. Touch sensors, motors and third-party/I2C devices are read-only. Internal and calibration modes are excluded. Mode changes require a confirmed stopped user-program slot; running or unknown status disables the control. The application checks the program state and sensor identity again before sending a change and verifies the resulting mode. It never stops a program automatically, saves mode preferences, or restores an earlier mode after closing Monitor or reconnecting. A program started directly on the brick can change the sensor mode again.

All available channels are shown; unlabeled multi-channel data uses channel numbers. Use **Plugin tools → Sensor Lab** for recording, comparison, CSV export and calibration; see [Sensor Lab](sensor-lab.md). Use **Plugin tools → Motor test** for jog, timed and angle tests; see [Motor testing](motor-test.md). The former Lab subpage and motor cards are removed. Testing pauses ordinary monitoring and cannot run alongside recording. Daisy-chain monitoring is not included. USB recovery uses the replacement session and discards old replies. Closing Monitor without an active recording stops future samples without interrupting a pending USB exchange or disconnecting the brick.

The desktop smoke uses simulated samples. The maintainer’s 2026-10-12 physical confirmation applies to the earlier implementation, not Stage 3; retain the [monitor acceptance procedure](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md#live-monitor--即時監測) for future regression checks.

## Required acceptance scenarios

Use the [manual hardware tools](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md) with the fixtures and restrictions in the acceptance record. These checks require a connected brick and are excluded from ordinary CI.

- Discover, connect, upload, run, stop, delete, and disconnect over USB on all three platforms.
- Connect by address and perform the same lifecycle over Wi-Fi on all three platforms.
- Permission denied, no device, wrong address, refused connection, timeout, malformed reply, full storage, and disconnect during upload.
- User cancellation during discovery, connect, and upload.
- Reconnect after a recoverable error without restarting the IDE.
- Verify that failure never transitions the UI or API result to success.
- Monitor Color mode changes, IR multi-channel readings, Gyro initialization, negative motor angles, battery values and programs started/stopped directly on the brick. Verify pause/resume and USB recovery with pending samples.

Bluetooth remains out of v1 because discovery, pairing, serial profiles, permissions, and packaging differ substantially across operating systems.

<a id="windows-stage-3-journal-policy"></a>

## Windows Stage 3 journal policy

R1 selects a verified native durable replacement/barrier adapter while preserving the full safety guarantee and intended Windows scope. The prototype is not production support: Windows feasibility, namespace/power-loss semantics and packaged integration remain open. Production currently fails closed with `ENOTSUP` at directory sync. Motion and program launch can fail before dispatch; trusted Stop can fail at its preceding journal commit. Startup barrier failure can precede fault inventory, so an empty fault list does not establish a clean profile. Do not equate this with every application operation failing: editing/compilation, passive reads and clean idle quit are separate cases.

Windows Stage 3 device execution/recovery is **not accepted** until those gates pass. No platform deferral or weaker safety guarantee is approved, and B2's record-store policy cannot waive the device journal. See the [Windows acceptance ledger](../superpowers/plans/2026-10-17-plugin-system-3a-acceptance.md). All delivered platforms still require final native/installed evidence and named physical/human results. A second launch must only focus/restore the primary without another writer/provider/recording; real suspend must end work without wake replay. These remain explicit cases in the hardware/UI checklist.
