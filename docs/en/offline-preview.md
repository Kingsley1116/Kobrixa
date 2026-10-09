# Local robot simulator

Open a Basic Plus project and choose **Local simulator**, or press **Alt+F5**. The simulator opens beside the editor. It runs locally without an EV3 or network connection, and never uploads to or controls a physical device.

**Expand workspace** hides the editor and gives the simulator the full work area. **Show editor** restores the split view without restarting the simulation. Source links also restore the editor automatically. Controls retain their size in smaller windows; settings remain scrollable.

The default scene uses the WRO Double Tennis 2026 mat, with your project controlling robot A1. The other three robots are initially disabled. Choose **Match** to activate disabled robots as built-in opponents; any robots already assigned project programs keep those assignments. You can assign a different project-relative `.bp` entry to each robot.

## Run and inspect

- **Start / Pause** runs or pauses the world. The first start saves and compiles the assigned project programs. A failed preparation shows diagnostics and cannot run an older compilation.
- **Recompile** refreshes program and resource snapshots and returns to setup. Use it after editing code. The editor remains available beside the simulator.
- **World step** advances the prepared world by 10 milliseconds, including every robot, physics, sensors and program scheduling. First recompile to prepare a scene without starting it. This is a world-time step, not a source-code step.
- **Stop** ends the run. **Reset scene** restores the compiled scene, original ball positions, program state and resource files. Reset before changing setup.
- **Speed** selects 0.25×, 0.5×, 1×, 2× or 4× wall-clock playback. The physics timestep stays fixed.
- **Save scene** stores `kobrixa.simulator.json` in the project. It uses the normal editor save and conflict handling. Scene files contain setup, not live execution state. Closing the scene JSON editor tab also closes its live simulator view, so discarded scene edits cannot keep an older scene running.

Select a robot on the field, in its metric card, or in the robot selector. **Live inspector** shows its LCD, button pad, motor speed/count, sensor readings, current source location, call stack and variables. Source links focus the editor. Array and variable previews are bounded and explicitly identified when shortened; the interpreter retains complete program data. Nonfinite numbers remain visible as `NaN`, `Infinity` and `-Infinity`.

Each robot card shows its assigned `.bp` filename or built-in difficulty separately from its execution status. Hover over a program name for the full project-relative entry. These assignments come from the current simulator scene; opening a source file in the editor does not change which program a robot runs.

Hold EV3 buttons with the pointer or Space/Enter while focused. Arrow keys and Backspace also work in the pad. Losing focus releases held buttons. Hiding the simulator or application pauses the world; unmounting the workspace terminates its worker. Resuming requires Start. Stopping, closing, hiding or replacing a scene during compilation cancels its pending preparation; a late result cannot start a discarded run.

Trails, sensor rays, headings, collision hints and restricted zones can be toggled independently. Collision hints mark robots with contact events in the last simulated second. If any robot program fails, the top alert shows its identity, error and source location; the source action selects that robot and opens its code.

## Scene setup

Drag robots and balls before running, or edit numeric positions. Drag empty field space to pan; use the wheel, +/− controls or Fit field to zoom. Coordinates are millimetres from the mat’s bottom-left corner; +X points right and +Y points up. Headings are counterclockwise degrees from +X. Robot-local +X is forward and +Y is left.

**Apply seed** recreates the ball arrangement and match duration for the displayed seed. **New seed & balls** advances the seed and generates a new arrangement. Saving the scene or resetting the prepared run lets you reproduce the same setup. You can also place balls manually.

Robot settings include:

- Team and controller: a project entry, a built-in opponent (Easy, Standard or Hard), or disabled.
- Differential, three-wheel omni or four-wheel omni drive; wheel motor ports, locations, rolling angles, diameter, motor-turns-per-wheel-turn gear ratio and reversed direction.
- Body dimensions, mass, start pose, pusher size and depth.
- Sensor ports and type, mounting position, angle, range and field of view.
- A shooter with its own motor port, mounting pose, firing elevation, motor stroke, launch speed and pickup range. Four-wheel drive uses A–D and therefore disables the shooter.

Invalid or conflicting ports, impossible wheel geometry, duplicate robot names and out-of-range values are reported before starting. A team has at most two robots; the scene has at most four.

## Built-in opponents

A built-in opponent plays by the same information a project program has: its own mounted sensors and motor encoders, plus the published mat layout and its own robot setup. It never reads other robots' or balls' true positions.

- It tracks its own position from wheel encoders and the gyro, respecting the gyro's reversed-direction setting before applying the initial heading and team coordinate conversion. It corrects drift when its color sensor crosses printed lines or ramp color bands. It keeps a turning-radius margin from the centre line and its red ramp band, so it does not cross into the opponent half.
- It looks for orange balls in its own half, remembers ones that drop out of view, and leaves purple balls in its half alone (each is worth −2 to that side). It prefers an installed `KOBRIXA-VISION` sensor; otherwise it reads Pixy2 color blocks through the same I2C API available to programs and estimates bearing and distance from the camera geometry, block size and ball diameter. It will not fire when a purple ball is in its shooter's reach.
- It lines up behind a ball and fires it toward the other half, or pushes it with the pusher when the robot has no shooter. With no ball in sight it patrols and scans its half instead of turning in place.
- Two active robots on a team split their half into an upper and a lower court, with the area behind the barrier shared. A robot alone on its team covers the whole half.
- When ultrasonic readings or vision show it is pinned against another robot or a wedged ball, it backs off, turns and picks another target.

| Level    | Behaviour                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Easy     | Half speed, slow reactions, loose aim, reacts only to the ball currently in view, straight shots only.                              |
| Standard | The default. Faster, remembers balls for several seconds and can shoot at an angle.                                                 |
| Hard     | Quickest reactions, works closer to the centre line, wider angles, and bank shots off its own back wall for balls stuck against it. |

Scenes saved before levels were added load as Standard. A robot without either vision sensor drives sweeps across its court instead of targeting balls. Pixy2 observations cannot identify untrained colors or distinguish orange and purple assigned the same signature; the opponent does not guess their class. A block clipped by the image boundary is unsuitable for precise shot positioning. These estimates do not give the opponent access to true ball positions.

## Sensors and local communication

Sensor values come from the simulated world rather than manual sliders. Configure sensor placement to match the robot code.

| Sensor     | Model and readings                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color      | Samples the mat beneath its mount. Mode 2 returns a color ID, mode 4 RGB channels, mode 3 raw reflected channels, other modes a light percentage. Lighting and calibration are approximate.                                               |
| Ultrasonic | Casts a small fan of rays against the scene. Modes 1/4/6 return inches; ordinary distance modes return centimetres; listen mode 2 returns zero.                                                                                           |
| Gyro       | Measures heading relative to initial pose and angular velocity. Mode 3 returns angle and rate, modes 1/2 rate, other modes angle.                                                                                                         |
| Touch      | Approximate short-range contact detection in the configured direction.                                                                                                                                                                    |
| Pixy2      | LEGO I2C color blocks from visible balls. Configure trained signatures, camera height, tilt and horizontal/vertical fields of view; read counts and bounding boxes through the existing I2C API.                                          |
| Vision     | Synthetic `KOBRIXA-VISION` sensor, type 124. SI channels are `[detected, bearingDegrees, distanceMillimetres, class]`, where class 1 is orange and 2 purple. Modes 0/1/2 select all/orange/purple balls. No detection returns four zeros. |

Vision is a simulator facility, not an emulation of a specific camera. It checks range, field of view and scene occlusion, and chooses the nearest visible ball.

### Pixy2 for LEGO

Choose **Pixy2 camera (LEGO)** as a sensor type in Robot setup. The preset uses a 60° horizontal view, 40° vertical view, 2,500 mm range, 100 mm mounting height and −10° tilt. Mounting height is above the robot's base, which rises on a ramp; positive tilt points upward. Orange balls default to signature 1 and purple to signature 2. Each color can use signature 1–7 or **Not trained** (0); assigning both colors the same signature combines their detections. These settings are saved with the scene.

The camera projects visible balls into image blocks, accounting for mounting position, orientation, height, ball elevation, range, field of view and occlusion. The LEGO packet uses unsigned-byte coordinates (0–255), with X right and Y down, scaled like the manufacturer's firmware rather than native Pixy2 image pixels. Block size can be used to estimate distance; there is no distance field. This models color-connected-components detection, not image processing, line tracking, RGB reads, video, tracking IDs or multi-color codes.

Use the existing Basic Plus I2C calls with device address **1**:

| Read                                                                     | Returned bytes                                                                                                        |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `Sensor.ReadI2CRegisters(port, 1, 80 + signature, 5)` for signatures 1–7 | `[count, x, y, width, height]` for the largest block with that signature; count includes all visible matching blocks. |
| `Sensor.ReadI2CRegisters(port, 1, 80, 6)`                                | `[signatureLow, signatureHigh, x, y, width, height]` for the largest block overall.                                   |
| Register `0x42`, length 1                                                | X of the largest block.                                                                                               |
| Register `0`, length 5                                                   | Version string `V0.4` plus a terminating NUL byte.                                                                    |
| Registers `8` or `16`, length 6                                          | Vendor/device identity string `Pixy2` plus a terminating NUL byte.                                                    |
| Register `0x60`, length 1                                                | Zero: this scene models individual color signatures, so it has no color-code angle.                                   |

When no target is visible, supported block reads return the requested number of bytes, all set to zero. Reads may request a shorter prefix of a reply; lengths beyond the documented reply size are rejected. `Sensor.GetName(port)` reports `Pixy2`; mode 0 SI/raw reads expose only the largest block's X, not the four-channel `KOBRIXA-VISION` interface. `Sensor.GetType` uses the simulator's generic I2C value 100, not a manufacturer hardware ID. The lamp command at register `0x62` is accepted without changing scene lighting. Other protocols and unsupported registers are reported rather than simulated as successful hardware communication.

The [Pixy2 example](../../examples/simulation/pixy2-search/) reads and displays signature-1 blocks without moving the robot. The packet layout follows the [manufacturer's LEGO I2C firmware](https://github.com/charmedlabs/pixy2/blob/master/src/device/main_m4/src/serial.cpp); the [LEGO block guide](https://docs.pixycam.com/wiki/doku.php?id=wiki:v2:pixy_lego_block) explains signature selection and block measurements. A real Pixy2 must be separately configured and color-trained; the simulator never connects to a camera.

Local Mailbox operations communicate between named robots on the same team. Send targets an exact robot ID or name; broadcasts and external connections are unavailable. Text and number mailbox types must match. Writes become visible at the next world tick. A mailbox keeps its latest unread value; receiving consumes it and waits when empty. Deterministic sender ordering resolves simultaneous writes. No Bluetooth or host network is used.

## Match and physics scope

The mat is 2,362 × 1,143 mm. The scene includes the printed lines, walls, central barrier, ramps, ten side balls and the central orange ball. Differential and omni wheel geometry converts motor motion into robot movement. Bodies and balls collide; pushers move balls; shooters create a simplified vertical trajectory alongside the 2D rigid-body simulation.

Each ramp is a solid wedge with a 300 × 563 mm footprint, rising from 0 to 50 mm across its 300 mm width. The court shows uphill arrows, height labels and a heavy line at the high vertical end. Robots and balls can climb the low entrance; the raised side and high-end faces obstruct entry below their surface height. Airborne balls clear the wedge only when high enough, and the solid ramp can occlude distance and vision sensors. The model tracks a simplified robot base elevation; it does not pitch or tilt the chassis, simulate suspension, or calculate motor load on the slope. The court remains a top-down view, and its height shading does not change the collision footprint.

Wheel collision behavior defaults to **Spin when blocked** (`wheelTraction: "slip"`). Choose **Stop when blocked (approximate)** (`"grip"`) for programs that detect a wall from stalled encoders. In this mode wheel travel follows the motion allowed by contacts; reversing releases the stall. It is a traction approximation, not a motor torque model. Encoder resets remain independent of body position.

Match duration is 70–120 seconds from the seeded die roll unless edited. Match mode stops at the configured time; practice continues and marks scores as provisional. The score uses orange +1 and purple −2 on each side: lower wins. The untouched central ball is excluded. Touching-ball attribution is reflected in the provisional score. Entering a red ramp zone, crossing into the opponent half or any part of the robot footprint leaving the mat pauses the simulation and logs the violation. A ball leaving the mat is returned to a designated corner: orange to the responsible team and purple to the other team; this also pauses the world. Pressing Start after a violation continues as practice with provisional scores, including when the scene began in Match mode. No official referee penalties or human adjudication are applied.

The model approximates friction, wheel traction, contact, motor response, ramps, gravity, sensors and vision. It does not reproduce tire deformation, precise motor loading, robot pitch or suspension, camera image processing or every competition ruling. Use it for program development and repeatable experiments; verify actual robots, safety and official scoring separately.

## Program support and limits

Programs run as compiled KobrixaIR with float32/int32 arithmetic, branches, loops, functions, arrays, cooperative threads and the supported EV3 library operations. LCD graphics and RGF assets are rendered locally. Tones and uncompressed RSF produce duration/output events rather than audible playback. Project resources are immutable compilation snapshots; writable virtual files stay in memory and are discarded on reset.

Resources are limited to 64 files and 1 MiB total per program. Instruction, thread, call-depth, string and array limits prevent unbounded execution. Physics and interpreter work run in bounded batches inside a dedicated worker, so a runaway program cannot monopolize the editor. Logs and trails retain bounded histories.

This is not a native `.rbf` firmware emulator. Host system commands, physical I2C/UART/third-party communication, daisy-chain hardware and external networking are unsupported. Missing assets, unsupported calls and runtime errors report their cause and available source location instead of returning invented success.

## Examples and rule sources

The [simulation examples](../../examples/simulation/README.md) cover a differential route, omnidirectional movement, vision search, Pixy2 I2C blocks, a motor shooter and two-robot Mailbox cooperation. Open any lesson from the IDE example library and press Alt+F5 to load its included scene.

The field and setup follow the [WRO 2026 Double Tennis general rules](https://wro-association.org/wp-content/uploads/WRO-2026-RoboSports-Double-Tennis-General-Rules.pdf) and [official Q&A](https://wro-association.org/competition/questions-answers/). The [Planck.js](https://github.com/piqnt/planck.js) physics engine ships with the desktop app; runtime does not download field assets or libraries.

Every world step is fixed at 10ms, with at most 1,000 IR instructions per robot per step. Playback speed changes only how many steps are processed. Identical compiled programs, scenes, seeds and operations reproduce results in the same execution environment; bit-for-bit floating-point equality across platforms is not promised.
