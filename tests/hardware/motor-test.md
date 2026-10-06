# Motor test hardware acceptance / 馬達測試實機驗收

Status: **not yet performed / 尚未執行**. Record actual observations; do not infer hardware support from unit tests or renderer smoke.

For each run record OS/version, application commit/version, EV3 firmware, motor type, output port, USB/Wi-Fi, requested power/direction/brake, measured displacement, stop delay, result, and effects on other outputs. Start with unloaded, secured motors clear of hands and mechanisms. Do not automate powered stall tests unattended.

| Platform    | USB     | Wi-Fi   |
| ----------- | ------- | ------- |
| Windows x64 | Pending | Pending |
| macOS arm64 | Pending | Pending |
| Linux x64   | Pending | Pending |

1. On each A–D port, verify large and medium motor identification; missing and unknown outputs cannot start. Check an already-running program, another moving motor, recording, and stale readings block start.
2. Jog forward/reverse at 20%; verify pointer release, Space/Enter release, touch cancel, focus loss and the ten-second limit. Confirm no repeated start after release, including release during preparation.
3. Run timed movements at 0.1, 1 and 5 seconds with brake/coast. Check power limits, actual stop behavior, angle and displacement without resetting hardware counts.
4. Run relative angles in both directions, including 90° and 360°. Use a controlled low-power fixture to verify the ten-second watchdog when the target cannot be reached. Record timeout and stop behavior.
5. Release/stop during upload, startup and an in-flight read. Close the expanded card and switch monitor subviews/tool pages. The controller must remain visible if stop is unconfirmed.
6. Remove USB or interrupt Wi-Fi during each mode. Confirm finite on-brick termination, unconfirmed UI status, and no restart on reconnect. Do not assume braking remains engaged after disconnect.
7. Verify program startup/shutdown effects on every unselected output. Check the requested final brake/coast state after helper shutdown.
8. Interrupt/replace the helper from the brick. The IDE must not stop an unrelated program or fabricate a completed result. A leftover helper launched manually without the current handshake must not drive a motor.
9. Verify renderer failure, sleep, window close and update preparation request stopping; confirm normal monitoring resumes after a completed test. No run/deploy/file mutation or recording may interleave with a test.
10. Check temporary-file cleanup, including a cleanup failure; unrelated projects remain intact. Repeat key UI cases in English and Traditional Chinese at narrow sidebar width.

Attach observed results and limitations before marking any cell passed. 如有任何無法確認的停止或非選定埠影響，請保留原始紀錄，不標示成功。
