# Simulator usability — design

Agreed on 2026-10-11 after a design interview. The simulator stays development-only
(`SIMULATOR_ENABLED` unchanged); success is judged by one or two students completing the
trial script in `tools/usability/`.

## Goals

- Primary users: WRO secondary-school competitors; a first-time EV3 user must not get stuck in
  the first minute.
- Pain points addressed: (a) the run/recompile/reset/stop state machine, (b) too many robot
  setup fields. Out of scope: physics accuracy, new sensors, new competition fields.

## Run flow

- Toolbar: Start/Pause, Step (10 ms), Reset. Recompile and Stop are removed.
- Start compares the open sources with the compiled snapshot. When they differ, or the last run
  ended, it saves, compiles, resets and runs; otherwise it resumes.
- Step works from any non-running state and prepares the scene first when needed.
- Setup is always editable. Editing a live scene resets it and shows a short notice.
- When the editor changes after compiling, the toolbar shows "Program changed — press Start".

## Practice field

- `ruleset: "practice" | "wro-double-tennis-2026"` (existing field widened; old files are WRO).
- Opening the simulator without `kobrixa.simulator.json` creates a practice scene.
- 2362 × 1143 mm white mat with walls and a 20 mm black rounded-rectangle loop; one robot starts
  on the loop's lower-left straight, facing +X.
- No score, balls, seeds, opponents, ramps, barrier or zone rules; leaving the mat still pauses.
- A field picker in the toolbar switches fields; unsaved scene edits require confirmation.

## Robot setup

- Presets: Driving Base (B/C motors; touch 1, gyro 2, color 3, ultrasonic 4), WRO default robot,
  Custom (any edit away from a preset).
- Basic: preset, controller, drive motor ports, sensor kind per port. Everything else lives in a
  collapsed Advanced section.

## Port warnings

- After compiling, literal motor letters and sensor ports used by the program are compared with
  the robot. Mismatches show a non-blocking warning with an "Open robot setup" action.
