# Motor testing

Stage 3 integration draft: this guide describes the public Motor test plugin. Product activation and removal of the older Monitor card are pending the integration gates; this branch is not a released installation.

Connect an EV3 through the device tools, then open **Plugin tools → Motor test**. Press **Use current connection** to select the connected session, and choose output **A–D**. Opening the panel, refreshing availability or enabling the plugin never connects a device or starts motion. No source program is required.

Only recognized local EV3 large and medium motors are supported. A running program, moving output, Sensor Lab recording, unavailable provider, stale reading or missing control authority blocks starting. A collaboration viewer cannot start motion. **Refresh availability** checks current availability; it does not retry a previous motion.

## Controls

Each output has its own draft parameters. Choose Jog, Timed or Relative angle. Invalid or incomplete values are shown beside their fields and prevent starting. Power is unregulated output power, not a fixed speed.

- Power defaults to 20% and accepts 1–100%.
- **Jog:** hold **Hold forward** or **Hold reverse** with the pointer or Space/Enter on the focused button. Releasing or cancelling the hold requests stopping. The held button determines direction; a jog lasts at most ten seconds.
- **Timed:** defaults to one second, accepts 0.1–5 seconds and uses the selected direction.
- **Relative angle:** defaults to 90°, accepts whole degrees from 1–3,600 and uses the selected direction. An unfinished movement times out after ten seconds.
- Normal completion can brake or coast. **Stop (brake)** requests braking even when another field contains an invalid draft. Coast can continue rotating; braking is not a mechanical lock.

The panel shows phase, movement, dispatch and stop confirmation, with elapsed/angle progress when known. Unknown readings remain unknown rather than becoming zero. Encoder values do not account for gearing, slip or backlash, and the test does not reset the hardware count.

Changing ports retains each port's drafts. Hiding or voluntarily closing/reopening the panel in the same workbench retains bounded draft values and unfinished numeric input, but never restores motion, authority or an old operation. Process/resource replacement and workbench retirement clear retained drafts. These drafts are not durable preferences and do not survive restarting the app.

## Stopping and recovery

Release, hide, panel/window close, focus loss, authority loss, sleep, disable and plugin failure request stopping. Reopening the panel, waking, reconnecting or re-enabling never resumes a test. Stop requests and host readback are distinct from physical stopping: an exchange already in flight and firmware scheduling can delay the result.

When a start reply is lost, the plugin queries the original operation. It does not issue a second start. If stopping cannot be confirmed, the UI keeps an explicit uncertain result; use **Open core recovery** to inspect the host's retained evidence. A normal disconnect or quit can remain blocked while stopping/saving is unresolved. Do not interpret a process exit or a forced quit as confirmed motor stopping.

The device remains exclusively reserved for the test; competing program/deployment/file changes, mode changes and recording cannot interleave. Local editing remains available. Existing finite EV3 motion deadlines, helper cleanup and core recovery remain responsible for device safety; the plugin does not replace them. Cleanup removes only its own temporary program, never user projects.

## Availability and acceptance

Motor test is an optional builtin, enabled by default once delivered. Its toggle is independent of the device provider. Disabling it stops its work; re-enabling only makes it available. If safe mode suppresses its process, the panel is unavailable while core recovery remains accessible. Follow the plugin settings' explanation before explicitly restoring it.

The [hardware checklist](../../tests/hardware/motor-test.md) records USB/Wi-Fi, operating systems, motor types, clean installation and manual accessibility separately. Software fixtures, bundle audits and native fake-provider runs do not establish physical-device acceptance. Unrun gates remain pending.
