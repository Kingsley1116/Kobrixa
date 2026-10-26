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


## Stage 3 public-plugin acceptance — UNRUN

The earlier card-based checklist records legacy behavior. For Stage 3 use **Plugin tools → Motor test → Use current connection**, not the removed Monitor-card route. Product activation/removal is still pending integration. No row below has been performed or signed off.

Record tester/date, OS/architecture, app commit and installed artifact SHA-256, EV3 firmware, motor type/port, transport, requested motion, load, and raw logs/video. Record three separate timestamps/outcomes: stop requested; host readback/confirmation; physical motion observed stopped. A successful request does not fill the other two columns.

| Public-route case | USB | Wi-Fi | Evidence |
| --- | --- | --- | --- |
| Jog, timed and angle on A–D, both motor types; defaults and bounds | UNRUN | UNRUN | — |
| Release/cancel during prepare, start, arm and pulse; lost/late reply never repeats start | UNRUN | UNRUN | — |
| Hide, close, blur, renderer crash/freeze, plugin kill or authority loss | UNRUN | UNRUN | — |
| Core Stop with invalid fields or busy command; confirmed versus unconfirmed recovery | UNRUN | UNRUN | — |
| Recording/program ownership blocks motion; no interference with unselected outputs | UNRUN | UNRUN | — |
| Disconnect/reconnect, sleep/wake, disable/re-enable and provider toggle never resume | UNRUN | UNRUN | — |
| Normal quit blocker and forced exit uncertainty; second instance does not start motion | UNRUN | UNRUN | — |
| Port drafts, invalid raw, close/reopen; new resource/process clears drafts | UNRUN | UNRUN | — |

Clean-install/manual S3-15: test each delivered OS/architecture without checkout or user Node, offline launch, missing/corrupt payload, independent feature/provider toggles, safe-mode cold suppression and core recovery, both locales/themes, 320 CSS px at 125%, keyboard/focus and actual screen-reader speech. All remain **UNRUN**. Attach named observations before changing status; simulated provider and accessibility-tree output cannot sign these rows.
