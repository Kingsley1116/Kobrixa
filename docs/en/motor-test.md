# Motor testing

Connect an EV3, open **EV3 tools → Monitor → Readings**, and select **Test** on an A–D motor card. One card expands at a time. No project or source program is required.

USB and Wi-Fi support local EV3 large and medium motors. The user program must be stopped and every motor idle. Stop Sensor Lab recording first. Each test checks fresh device state; unknown or invalid readings do not authorize motion.

## Controls

Choose **Jog**, **Timed** or **Angle** at the top of the card. Power uses a slider with a numeric field; direction and finish mode are two-way switches. Out-of-range values are flagged beside the field and keep the test from starting. When a test cannot start, the card states why (for example, a running EV3 program or an active recording).

- Power starts at 20% and accepts 1–100%. This is unregulated power, not a fixed speed.
- **Jog:** hold **Hold reverse** or **Hold forward** with the pointer, touch, or Space/Enter on the focused button. The button you hold sets the direction; the direction switch applies only to timed and angle tests. Release requests a stop. Each hold lasts at most 10 seconds.
- **Timed:** defaults to one second, adjustable from 0.1 to five seconds, in the selected direction.
- **Angle:** relative to the current position; defaults to 90°, adjustable from 1 to 3,600°. A movement that has not finished after ten seconds ends with a timeout.
- Normal completion defaults to braking; coast is optional. While a timed or angle test runs, **Start test** becomes **Stop**, which always requests braking. Coasting can continue to rotate, and firmware braking is not a mechanical lock.

The status panel shows the result, a progress bar (elapsed time for timed tests, displacement toward the target for angle tests, and the 10-second limit for jogging), encoder angle and displacement from the start. Tests never reset the hardware encoder count. Encoder readings do not compensate for gearing, wheel slip, or backlash.

Parameters and other motor test entries are disabled during motion. Ordinary monitoring pauses while the test updates its own readings, then resumes. Concurrent Sensor Lab recording is outside this version's scope.

## Stopping and recovery

Collapsing the card first stops the test; a failed stop leaves its controls and result visible. Switching monitor views or tool pages, closing the sidebar, losing window focus, sleep, quitting, and update preparation also request a stop. An exchange already in progress must finish first, so the stop button does not guarantee zero-latency physical stopping.

Each jog command has a 400 ms firmware deadline and is renewed only while valid hold intent continues. Timed motion ends in firmware. Relative angle motion uses a small temporary EV3 program with an on-brick ten-second watchdog. It cannot drive a motor without the current invocation's handshake, and retains its result for two seconds before exiting.

EV3 program startup and shutdown affect the firmware state of all motor outputs. The entire test therefore owns the device: running another program, deployment, remote file changes, sensor mode changes, and starting recording are blocked. Local source editing remains available.

Disconnects show **Stop unconfirmed**, rather than claiming an acknowledged stop. Reconnection never resumes motion. When the USB serial number or Wi-Fi address identifies the same EV3, a read-only check can confirm current idleness; the previous test result remains unavailable. Firmware/VM scheduling implements the limits; these are not hard real-time guarantees and do not guarantee sustained braking after disconnect. Cleanup removes only the temporary program created for this invocation. A cleanup error is reported without deleting user projects.

## Acceptance status

Automated coverage includes protocol, main-process, UI, and test-VM behavior. Physical USB/Wi-Fi checks on all three platforms and both motor types remain subject to the [motor test hardware checklist](../../tests/hardware/motor-test.md). Passing simulated tests does not establish physical-device acceptance.
