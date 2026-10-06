# Device and platform support

## v1 support matrix

| Desktop target      | USB HID                                  | Wi-Fi                                    | Bluetooth       |
| ------------------- | ---------------------------------------- | ---------------------------------------- | --------------- |
| Windows x64         | Implemented; platform acceptance pending | Implemented; platform acceptance pending | Not implemented |
| macOS Apple Silicon | Implemented; platform acceptance pending | Implemented; platform acceptance pending | Not implemented |
| Linux x64           | Implemented; platform acceptance pending | Implemented; platform acceptance pending | Not implemented |

Support is not considered shipped until automated transport tests and physical reference-brick tests pass on that platform.

The shared USB and Wi-Fi transports already exist in `packages/device`. The [hardware acceptance record](https://github.com/Kingsley1116/Kobrixa/blob/main/examples/HARDWARE-ACCEPTANCE.md) includes USB example runs and documents their limits; it does not complete the three-platform USB/Wi-Fi matrix. Record the operating system, firmware, transport, exact application version and observed results for each acceptance run. Desktop signature validity is checked separately under the [code signing policy](../en/code-signing.md).

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

The remote file browser also supports directory listing, downloads, folder creation, rename and deletion. Batch transfers preview conflicts before execution. Local downloads use a temporary file and commit only after a complete transfer; remote rename uses copy/verification/delete behavior because the EV3 firmware does not provide an atomic rename.

Remote paths are normalized as EV3 paths. Parent traversal, embedded nulls, invalid lengths, and unsupported names are rejected before transport I/O.

## Live monitor

Open **EV3 tools → Monitor** after connecting over USB or Wi-Fi. The panel shows local input ports 1–4, output ports A–D, battery percentage and voltage, and the EV3 user-program slot status. That status describes the program on the brick; it does not identify the currently edited project. Motor angles are read without resetting their counters.

Without an active recording, sampling runs only while Monitor is selected, the tools panel is open, and the window is visible. An active recording keeps the same main-process scheduler running in the background. Each completed sample is followed by a 500 ms delay. Foreground operations take priority and there is at most one outstanding sample; uploads, file batches and confirmation waits pause monitoring. Paused, busy or failed samples preserve the last values and mark them as no longer live. The timestamp is the last successful sample, not a promise of continuous updates. Empty ports, initializing devices, unknown devices and unavailable values are distinct; invalid readings are never shown as zero.

Official EV3 UART sensors offer the firmware's Port View modes through **Change mode**. Touch sensors, motors and third-party/I2C devices are read-only. Internal and calibration modes are excluded. Mode changes require a confirmed stopped user-program slot; running or unknown status disables the control. The application checks the program state and sensor identity again before sending a change and verifies the resulting mode. It never stops a program automatically, saves mode preferences, or restores an earlier mode after closing Monitor or reconnecting. A program started directly on the brick can change the sensor mode again.

All available channels are shown; unlabeled multi-channel data uses channel numbers. The **Curves & calibration** subpage adds recording, comparison, CSV export and numerical calibration; see [Sensor lab](sensor-lab.md). Motor cards in **Readings** expand to single-motor jog, timed and angle tests; see [Motor testing](https://github.com/Kingsley1116/Kobrixa/blob/main/docs/en/motor-test.md). Testing pauses ordinary monitoring and cannot run alongside recording. Daisy-chain monitoring is not included. USB recovery uses the replacement session and discards old replies. Closing Monitor without an active recording stops future samples without interrupting a pending USB exchange or disconnecting the brick.

The desktop smoke uses simulated samples. Physical monitoring acceptance is **not yet tested** on Windows, macOS or Linux for either USB or Wi-Fi; see the [monitor acceptance procedure](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md#live-monitor--即時監測) before recording a platform pass.

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
