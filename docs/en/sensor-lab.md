# Sensor curves and calibration

Connect an EV3, then open **EV3 tools → Monitor → Curves & calibration**. Select up to four channels from local input ports 1–4 and motor angles A–D. Channels and calibration are fixed while recording. Mode changes are disabled until recording stops.

Each channel has its own value axis; charts share elapsed time. Live charts show the latest 60 seconds; stopped recordings show the full duration. **Expand charts** opens a keyboard-accessible dialog with a shared time slider. Select **Raw** or **Calibrated** values. Use **View** and **Compare** in saved recordings to overlay two experiments from their respective start times, with solid and dashed lines. Only matching source definitions and units are overlaid. Historical values always use that recording's calibration.

## Recording and saving

Recording continues when the panel closes, another tab is selected, or the window is hidden/minimized. The footer shows elapsed time, waiting state and a stop button; its label returns to the lab. The visible monitor and recorder share one main-process sampler. Every completed read is followed by a 500 ms delay, with the actual interval shown. Upload/run/stop/file operations take priority. These are host receipt times and a monotonic host elapsed-time axis, not hardware-precise acquisition timestamps.

Busy operations, read errors and invalid values leave gaps. Values are never replaced with zero or duplicated from an old response, and graph segments do not bridge gaps. Confirmed source removal, type/mode/unit changes, disconnection/session replacement, or computer sleep stop recording with a reason. Reconnection requires manually starting another recording and applying calibration again.

A recording stops at 30 minutes or 3,600 snapshots, whichever comes first. Up to 50 recordings are retained; delete a recording before starting another at capacity. Versioned local files live under Electron `userData/sensor-lab`, with an atomic checkpoint every five seconds. After an unexpected exit, the last checkpoint is recovered as interrupted, without resuming recording. Unsaved data remains in memory after a write failure. Stop and use **Retry saving**; closing or installing an update waits for saving and is blocked on failure.

**Export CSV** opens the native Save dialog. UTF-8 BOM CSV contains one row per channel per snapshot, including recording name, receipt time, elapsed milliseconds, source, mode, raw/output units, raw/calibrated values and status. Missing numbers are empty fields. Cancelling creates no file, and export errors remain errors.

## Calibration and generated programs

Choose one channel under **Calibration**. Enable two-point scaling, capture fresh readings or enter measured A/B manually, and set their targets (initially 0–100). Reverse mappings and extrapolation are allowed; results are not clamped. **Zero current reading** subtracts the current converted value, or the raw value if scaling is off. Apply the settings before recording, or save a named profile for later manual reuse.

The mapping is `targetA + (x − sourceA) × (targetB − targetA) / (sourceB − sourceA) − zeroOffset`, with float32 rounding after each operation in that order. Nonfinite, stale, coincident or unrepresentable parameters are rejected. Invalid or overflowing results remain missing. Calibration does not change sensor firmware or reset motor counters.

**BASIC Plus program** previews a complete program and offers Copy. Running the generated sensor example checks type, explicitly selects the saved mode, waits for readiness, reads SI, validates and converts the result, then displays it. It never overwrites editor content. Motors use `Motor.GetCount`.

`Sensor.ReadSIValue(port, index)` reads the current mode's SI float without changing mode. Ports use the existing 1–16 addressing; indices are 0–7. SI means the firmware's mode unit. Invalid literal arguments produce a compiler diagnostic. Invalid dynamic arguments, absent channels, unavailable/nonfinite readings and a type/mode change during reading return `NaN`. The implementation follows `GET_TYPEMODE`, `GET_FORMAT`, `INPUT_TEST` and nonblocking `INPUT_READEXT` in the [LEGO Firmware Developer Kit, input port operations](https://assets.education.lego.com/v3/assets/blt293eea581807678a/blt469be1e11ad37696/5f880384f71916144453a49f/lego-mindstorms-ev3-firmware-developer-kit.pdf?locale=en-us).

This version excludes high-rate PID acquisition, cloud sync, firmware calibration and automatic tuning. USB/Wi-Fi hardware acceptance remains pending; use the [physical acceptance checklist](../../tests/hardware/sensor-lab.md). Automated VM and desktop smoke results do not replace hardware results.
