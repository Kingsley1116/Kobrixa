# Kobrixa examples

These 119 examples are independently authored for Kobrixa and progress from display-only first builds to local robot simulation and programs that need connected EV3 hardware.

<a href="./algorithms/">Algorithms</a> · <a href="./getting-started/">Getting started</a> · <a href="./capstones/">Capstones</a> · <a href="./display/">Display</a> · <a href="./sound/">Sound</a> · <a href="./media/">Media</a> · <a href="./time/">Time</a> · <a href="./buttons/">Buttons</a> · <a href="./control-flow/">Control flow</a> · <a href="./language/">Language</a> · <a href="./collections/">Collections</a> · <a href="./concurrency/">Concurrency</a> · <a href="./files/">Files</a> · <a href="./mailboxes/">Mailboxes</a> · <a href="./program/">Program</a> · <a href="./projects/">Projects</a> · <a href="./motors/">Motors</a> · <a href="./sensors/">Sensors</a>

| Category        | Example                                                    | What it teaches                                  | Hardware notes                       |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| Getting started | [hello-ev3](getting-started/hello-ev3/)                    | Text, a line, a tone, and a delay                | Display and speaker                  |
| Display         | [display-write](display/display-write/)                    | Simple black text with `LCD.Write`               | Display                              |
| Display         | [display-fonts](display/display-fonts/)                    | Tiny, small, and big fonts                       | Display                              |
| Display         | [display-shapes](display/display-shapes/)                  | Lines, concentric circles, and coordinates       | Display                              |
| Sound           | [speaker-scale](sound/speaker-scale/)                      | A four-note scale with arithmetic                | Speaker                              |
| Sound           | [speaker-interrupt](sound/speaker-interrupt/)              | Stop a long tone early                           | Speaker                              |
| Sound           | [speaker-melody](sound/speaker-melody/)                    | Named notes and `Speaker.Wait`                   | Speaker                              |
| Button          | [button-feedback](buttons/button-feedback/)                | Flush, wait for, and identify a button press     | EV3 brick buttons                    |
| Control flow    | [control-flow](control-flow/control-flow/)                 | Variables, arithmetic, `For`, and drawing        | Display and speaker                  |
| Control flow    | [while-loop](control-flow/while-loop/)                     | A finite `While` loop                            | Display                              |
| Control flow    | [if-elseif](control-flow/if-elseif/)                       | `If` / `ElseIf` / `Else`                         | Display and speaker                  |
| Control flow    | [boolean-logic](control-flow/boolean-logic/)               | Boolean values, `And`, and `Not`                 | Display and speaker                  |
| Control flow    | [comparison-operators](control-flow/comparison-operators/) | Parentheses, `>=`, `<>`, and combined conditions | Display                              |
| Control flow    | [nested-control](control-flow/nested-control/)             | An `If` nested inside a `For` loop               | Display                              |
| Control flow    | [labels-and-goto](control-flow/labels-and-goto/)           | Labels, forward `Goto`, and relocation           | Display and speaker                  |
| Control flow    | [break-and-continue](control-flow/break-and-continue/)     | Exit and skip loop iterations                    | Display                              |
| Language        | [case-insensitive](language/case-insensitive/)             | Mixed-case keywords, identifiers, and APIs       | Display                              |
| Language        | [text-and-math](language/text-and-math/)                   | Text composition and math functions              | Display                              |
| Language        | [byte-logic](language/byte-logic/)                         | Byte masks and hexadecimal formatting            | Display                              |
| Collection      | [row-vector](collections/row-vector/)                      | Fixed Rows and number Vectors                    | Display                              |
| Concurrency     | [thread-mutex](concurrency/thread-mutex/)                  | Background Sub, mutex, and yielding              | Display and LED                      |
| File            | [file-round-trip](files/file-round-trip/)                  | Write and read an EV3 project file               | Display; writes one EV3 file         |
| Mailbox         | [mailbox-local](mailboxes/mailbox-local/)                  | Create a named inbox and poll it                 | Optional second EV3                  |
| Program         | [program-end](program/program-end/)                        | Explicitly end an EV3 program                    | Display                              |
| Program         | [brick-status](program/brick-status/)                      | Brick name, battery, time, and LED               | Display and EV3 brick                |
| Project         | [include-settings](projects/include-settings/)             | One extension-free `Include` and shared values   | Motors A and D must be clear to move |
| Project         | [include-multiple](projects/include-multiple/)             | Multiple project-relative `.bpi` files           | Motor A must be clear to move        |
| Project         | [import-functions](projects/import-functions/)             | Imported `.bpm` Function return value            | Display                              |
| Motor           | [motor-move](motors/motor-move/)                           | Blocking movement, delay, and brake              | Motors A and D                       |
| Motor           | [motor-start-stop](motors/motor-start-stop/)               | Start motors continuously, then stop safely      | Motors A and D                       |
| Motor           | [motor-reverse](motors/motor-reverse/)                     | Negative speed and reverse movement              | Motor A                              |
| Motor           | [motor-sequence](motors/motor-sequence/)                   | Two blocking moves in sequence                   | Motors A and D                       |
| Motor           | [motor-counter](motors/motor-counter/)                     | Read a motor encoder and branch with `If`        | Motor A                              |
| Motor           | [motor-steer-sync](motors/motor-steer-sync/)               | Coordinated steering and synchronized movement   | Motors A and D                       |
| Sensor          | [sensor-threshold](sensors/sensor-threshold/)              | Wait, read a percentage, and select feedback     | Touch sensor on input port 1         |
| Sensor          | [sensor-sampling](sensors/sensor-sampling/)                | Repeated sensor sampling in a finite loop        | Touch sensor on input port 1         |
| Sensor          | [color-sensor](sensors/color-sensor/)                      | Read a detected color value in Color mode        | Color sensor on input port 1         |
| Sensor          | [gyro-sensor](sensors/gyro-sensor/)                        | Read a rotation angle in Angle mode              | Gyro sensor on input port 1          |
| Sensor          | [sensor-details](sensors/sensor-details/)                  | Sensor identity, mode, and raw values            | A sensor on input port 1             |

Each category is a physical folder under `examples/`; every link above opens the corresponding project folder. Open a project directory, its `kobrixa.json`, or its `src/main.bp` in Kobrixa. Build before connecting to an EV3. For motor examples, lift the robot so its wheels can turn safely during the first run.

## Extended curriculum

### Local 2D simulation

<a href="./simulation/">Simulation lessons</a> include saved practice scenes and run without an EV3:

- [differential-route](simulation/differential-route/) — Encoder travel and a 90° turn.
- [omni-lateral](simulation/omni-lateral/) — Lateral and forward motion with four omni wheels.
- [vision-search](simulation/vision-search/) — Synthetic vision with an explicit sensor identity guard.
- [pixy2-search](simulation/pixy2-search/) — Pixy2 LEGO I2C signature counts and image blocks, with a saved camera scene.
- [motor-shooter](simulation/motor-shooter/) — A motor stroke launches a nearby ball.
- [mailbox-cooperation](simulation/mailbox-cooperation/) — Two entries in one project exchange a target and acknowledgement.

### Further lessons

- [button-car](capstones/button-car/), [sensor-dashboard](capstones/sensor-dashboard/), [obstacle-rover](capstones/obstacle-rover/)
- [drawing-primitives](display/drawing-primitives/), [double-buffer-animation](display/double-buffer-animation/), [timer-slots](time/timer-slots/), [original-media](media/original-media/)
- [local-functions](language/local-functions/), [vector-workbench](collections/vector-workbench/), [binary-record](files/binary-record/), [import-module](projects/import-module/)
- [motor-schedule](motors/motor-schedule/), [raw-and-mode](sensors/raw-and-mode/), [i2c-registers](sensors/i2c-registers/)

See [core API coverage](API-COVERAGE.md) for the complete teaching map and [the learning path](LEARNING-PATH.md) for recommended lesson order.

## New lessons (2026-09-20)

These 20 lessons have their own [bytecode verification scope and instructions](NEW-EXAMPLES.md). Each includes bilingual run notes and expected results.

- [euclidean-gcd](algorithms/euclidean-gcd/) — Euclidean GCD.
- [fibonacci-sequence](algorithms/fibonacci-sequence/) — Fibonacci sequence.
- [prime-count](algorithms/prime-count/) — Prime counting.
- [insertion-sort](algorithms/insertion-sort/) — Insertion sort.
- [for-step-boundaries](control-flow/for-step-boundaries/) — For loop boundaries.
- [nested-loop-exits](control-flow/nested-loop-exits/) — Nested loop exits.
- [compound-arithmetic](language/compound-arithmetic/) — Compound arithmetic.
- [function-outputs](language/function-outputs/) — Function output parameters.
- [text-search](language/text-search/) — Text search and slicing.
- [row-statistics](collections/row-statistics/) — Row statistics.
- [matrix-product](collections/matrix-product/) — Matrix multiplication.
- [byte-sequence](files/byte-sequence/) — Byte sequence round trip.
- [finite-countdown](time/finite-countdown/) — Finite countdown.
- [fractional-coordinates](display/fractional-coordinates/) — Fractional coordinates.
- [computed-arpeggio](sound/computed-arpeggio/) — Computed arpeggio.
- [three-zone-light](sensors/three-zone-light/) — Three-zone reflected light.
- [five-sample-average](sensors/five-sample-average/) — Five-sample average.
- [power-ramp](motors/power-ramp/) — Power ramp.
- [button-choice](buttons/button-choice/) — Button choice.
- [import-calibration](projects/import-calibration/) — Imported calibration.

## Verification status

The syntax and argument order are cross-checked against the public [CLEV3R English Help](https://github.com/iCheh/Clev3r-1/tree/main/Clever/bin/Release/Help/en). In particular, these examples use `LCD.Text(color, x, y, font, text)`, color-first drawing calls, `Motor.Move(ports, speed, degrees, brake)`, both bare and legacy quoted Boolean values, one-based sensor ports, and extension-free `Include` paths. Every example is automatically parsed, lowered to version 1 IR, validated, and compiled to a structurally valid `.rbf`. Backend regression tests also check the documented integer operands, sensor-port conversion, and blocking behavior of `Motor.Move` against the [LEGO EV3 Firmware Developer Kit](https://assets.education.lego.com/v3/assets/blt293eea581807678a/blt469be1e11ad37696/5f880384f71916144453a49f/lego-mindstorms-ev3-firmware-developer-kit.pdf?locale=en-us).

These checks make the examples compiler- and bytecode-verified v1 candidates. Physical USB/Wi-Fi upload and execution still require an EV3 acceptance run on the stated hardware, so they are not described as hardware-certified yet.

The topic taxonomy was informed by the public CLEV3R example directory (control flow, functions, includes, sensors, motors, time, graphics, sound, files, mailboxes, and threads). No CLEV3R source, documentation, assets, or generated output is included here. Every shipped example is parsed, lowered, validated, and compiled to native bytecode; device-to-device mailbox exchange and physical hardware acceptance remain separate runtime checks.

## Clev3r curriculum expansion / Clev3r 課程擴充

[41-topic coverage and bytecode verification / 41 主題對照與字節碼驗證](CLEV3R-PARITY.md)

<a href="./benchmarks/">Benchmarks / 基準測試</a> · <a href="./daisy-chain/">Daisy chain / 串接</a> · <a href="./hitechnic/">HiTechnic</a>

- [control-flow/loop-exit-matrix](control-flow/loop-exit-matrix/) — Loop exit matrix
- [language/display-function](language/display-function/) — Display function
- [language/output-pipeline](language/output-pipeline/) — Output parameter pipeline
- [sensors/rgb-function](sensors/rgb-function/) — RGB function inputs
- [hitechnic/compass-heading](hitechnic/compass-heading/) — Compass heading error
- [hitechnic/infrared-direction](hitechnic/infrared-direction/) — Infrared direction and strength
- [projects/include-behaviors](projects/include-behaviors/) — Included robot behaviors
- [projects/nested-imports](projects/nested-imports/) — Nested imports and includes
- [capstones/scheduled-action-loop](capstones/scheduled-action-loop/) — Scheduled action loop
- [program/battery-under-load](program/battery-under-load/) — Battery under load
- [concurrency/sort-and-heartbeat](concurrency/sort-and-heartbeat/) — Sort and heartbeat
- [benchmarks/compute-and-draw](benchmarks/compute-and-draw/) — Compute and draw benchmark
- [buttons/held-button-drive](buttons/held-button-drive/) — Held-button drive
- [language/byte-workbench](language/byte-workbench/) — Complete byte workbench
- [buttons/click-stepper](buttons/click-stepper/) — Click-driven stepper
- [daisy-chain/two-brick-control](daisy-chain/two-brick-control/) — Two-brick control
- [files/typed-record](files/typed-record/) — Typed file record
- [media/graphic-sound-card](media/graphic-sound-card/) — Graphic and sound card
- [getting-started/brick-greeting](getting-started/brick-greeting/) — Brick greeting
- [sensors/i2c-register-workbench](sensors/i2c-register-workbench/) — I2C register workbench
- [mailboxes/paired-receiver](mailboxes/paired-receiver/) — Paired mailbox receiver
- [mailboxes/paired-sender](mailboxes/paired-sender/) — Paired mailbox sender
- [media/internal-media-folder](media/internal-media-folder/) — Media storage: prjs
- [media/sd-media-folder](media/sd-media-folder/) — Media storage: sd
- [sound/note-busy-sequence](sound/note-busy-sequence/) — Note and busy sequence
- [motors/encoder-profile](motors/encoder-profile/) — Encoder profile
- [motors/polarity-feedback](motors/polarity-feedback/) — Motor polarity and feedback
- [motors/steering-lifecycle](motors/steering-lifecycle/) — Steering lifecycle
- [motors/sync-lifecycle](motors/sync-lifecycle/) — Synchronization lifecycle
- [display/button-cursor](display/button-cursor/) — Button-controlled cursor
- [sensors/mode-inspector](sensors/mode-inspector/) — Sensor mode inspector
- [sensors/raw-channel-dashboard](sensors/raw-channel-dashboard/) — Raw channel dashboard
- [concurrency/shared-counters](concurrency/shared-counters/) — Concurrent shared counters
- [time/elapsed-intervals](time/elapsed-intervals/) — Elapsed intervals
- [sensors/touch-port-grid](sensors/touch-port-grid/) — Touch sensor port grid
- [algorithms/recursive-hanoi](algorithms/recursive-hanoi/) — Recursive Hanoi
- [motors/paired-trajectories](motors/paired-trajectories/) — Paired trajectories
- [collections/vector-toolkit](collections/vector-toolkit/) — Vector toolkit
- [collections/row-lifecycle](collections/row-lifecycle/) — Row lifecycle
- [sensors/port-raw-access](sensors/port-raw-access/) — Port-specific raw access
- [time/independent-timers](time/independent-timers/) — Independent timer slots
