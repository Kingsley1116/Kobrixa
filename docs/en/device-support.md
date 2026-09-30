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

## Required acceptance scenarios

Use the [manual hardware tools](https://github.com/Kingsley1116/Kobrixa/blob/main/tests/hardware/README.md) with the fixtures and restrictions in the acceptance record. These checks require a connected brick and are excluded from ordinary CI.

- Discover, connect, upload, run, stop, delete, and disconnect over USB on all three platforms.
- Connect by address and perform the same lifecycle over Wi-Fi on all three platforms.
- Permission denied, no device, wrong address, refused connection, timeout, malformed reply, full storage, and disconnect during upload.
- User cancellation during discovery, connect, and upload.
- Reconnect after a recoverable error without restarting the IDE.
- Verify that failure never transitions the UI or API result to success.

Bluetooth remains out of v1 because discovery, pairing, serial profiles, permissions, and packaging differ substantially across operating systems.
