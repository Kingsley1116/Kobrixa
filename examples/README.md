# Kobrixa examples

These 120 examples are independently authored for Kobrixa and progress from display-only first builds to local robot simulation and programs that need connected EV3 hardware.

Open a project directory, its `kobrixa.json`, or its `src/main.bp` in Kobrixa. Build before connecting to an EV3. For motor examples, lift the robot so its wheels can turn safely during the first run. See [the learning path](LEARNING-PATH.md) for recommended lesson order.

<a href="./getting-started/">Getting started</a> · <a href="./display/">Display</a> · <a href="./sound/">Sound</a> · <a href="./media/">Media</a> · <a href="./time/">Time</a> · <a href="./buttons/">Buttons</a> · <a href="./control-flow/">Control flow</a> · <a href="./language/">Language</a> · <a href="./collections/">Collections</a> · <a href="./algorithms/">Algorithms</a> · <a href="./concurrency/">Concurrency</a> · <a href="./files/">Files</a> · <a href="./mailboxes/">Mailboxes</a> · <a href="./program/">Program</a> · <a href="./projects/">Projects</a> · <a href="./motors/">Motors</a> · <a href="./sensors/">Sensors</a> · <a href="./hitechnic/">HiTechnic</a> · <a href="./daisy-chain/">Daisy chain</a> · <a href="./capstones/">Capstones</a> · <a href="./simulation/">Simulation</a> · <a href="./benchmarks/">Benchmarks</a>

## Getting started

| Example                                           | What it teaches                          | Hardware            |
| ------------------------------------------------- | ---------------------------------------- | ------------------- |
| [hello-ev3](getting-started/hello-ev3/)           | Text, a line, a tone, and a delay        | Display and speaker |
| [brick-greeting](getting-started/brick-greeting/) | Show the brick name in a welcome message | Display             |

## Display

| Example                                                     | What it teaches                                     | Hardware                  |
| ----------------------------------------------------------- | --------------------------------------------------- | ------------------------- |
| [display-write](display/display-write/)                     | Simple black text with `LCD.Write`                  | Display                   |
| [display-fonts](display/display-fonts/)                     | Tiny, small, and big fonts                          | Display                   |
| [display-shapes](display/display-shapes/)                   | Lines, concentric circles, and coordinates          | Display                   |
| [drawing-primitives](display/drawing-primitives/)           | Pixels, rectangles, inversion, and filled circles   | Display                   |
| [double-buffer-animation](display/double-buffer-animation/) | Draw complete frames before updating the LCD        | Display                   |
| [fractional-coordinates](display/fractional-coordinates/)   | Fractional coordinates become integer operands      | Display                   |
| [button-cursor](display/button-cursor/)                     | Button-driven cursor with double-buffered animation | Display and brick buttons |

## Sound

| Example                                         | What it teaches                              | Hardware |
| ----------------------------------------------- | -------------------------------------------- | -------- |
| [speaker-scale](sound/speaker-scale/)           | A four-note scale with arithmetic            | Speaker  |
| [speaker-interrupt](sound/speaker-interrupt/)   | Stop a long tone early                       | Speaker  |
| [speaker-melody](sound/speaker-melody/)         | Named notes and `Speaker.Wait`               | Speaker  |
| [computed-arpeggio](sound/computed-arpeggio/)   | Tone pitches computed from a loop variable   | Speaker  |
| [note-busy-sequence](sound/note-busy-sequence/) | Named notes, numeric tones, and busy polling | Speaker  |

## Media

| Example                                               | What it teaches                                     | Hardware                            |
| ----------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| [original-media](media/original-media/)               | Deploy and play original image and sound assets     | Display and speaker; deploys assets |
| [graphic-sound-card](media/graphic-sound-card/)       | Bundled RGF/RSF assets and playback                 | Display and speaker; deploys assets |
| [internal-media-folder](media/internal-media-folder/) | `Folder` chooses internal deployment and media base | Deploys to `prjs/KobrixaCard`       |
| [sd-media-folder](media/sd-media-folder/)             | `Folder` chooses SD card deployment and media base  | Writable EV3 SD card                |

## Time

| Example                                        | What it teaches                          | Hardware |
| ---------------------------------------------- | ---------------------------------------- | -------- |
| [timer-slots](time/timer-slots/)               | Reset and read timer slot 1              | Display  |
| [finite-countdown](time/finite-countdown/)     | Clock differences versus requested waits | Display  |
| [elapsed-intervals](time/elapsed-intervals/)   | Repeated elapsed-time measurements       | Display  |
| [independent-timers](time/independent-timers/) | Independent timer slots 1 and 9          | Display  |

## Buttons

| Example                                         | What it teaches                              | Hardware                  |
| ----------------------------------------------- | -------------------------------------------- | ------------------------- |
| [button-feedback](buttons/button-feedback/)     | Flush, wait for, and identify a button press | Brick buttons             |
| [button-choice](buttons/button-choice/)         | Read button state without an unbounded wait  | Brick buttons             |
| [click-stepper](buttons/click-stepper/)         | Consume clicks and move a fixed distance     | Brick buttons and motor A |
| [held-button-drive](buttons/held-button-drive/) | Held buttons choose motor power              | Brick buttons and motor A |

## Control flow

| Example                                                    | What it teaches                                  | Hardware            |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------- |
| [control-flow](control-flow/control-flow/)                 | Variables, arithmetic, `For`, and drawing        | Display and speaker |
| [while-loop](control-flow/while-loop/)                     | A finite `While` loop                            | Display             |
| [if-elseif](control-flow/if-elseif/)                       | `If` / `ElseIf` / `Else`                         | Display and speaker |
| [boolean-logic](control-flow/boolean-logic/)               | Boolean values, `And`, and `Not`                 | Display and speaker |
| [comparison-operators](control-flow/comparison-operators/) | Parentheses, `>=`, `<>`, and combined conditions | Display             |
| [nested-control](control-flow/nested-control/)             | An `If` nested inside a `For` loop               | Display             |
| [labels-and-goto](control-flow/labels-and-goto/)           | Labels and forward `Goto`                        | Display and speaker |
| [break-and-continue](control-flow/break-and-continue/)     | Exit and skip loop iterations                    | Display             |
| [for-step-boundaries](control-flow/for-step-boundaries/)   | Positive and negative `Step` boundaries          | Display             |
| [nested-loop-exits](control-flow/nested-loop-exits/)       | `Break` and `Continue` in the inner loop only    | Display             |
| [loop-exit-matrix](control-flow/loop-exit-matrix/)         | `Break` and `Continue` in `For` and `While`      | Display             |

## Language

| Example                                              | What it teaches                              | Hardware |
| ---------------------------------------------------- | -------------------------------------------- | -------- |
| [case-insensitive](language/case-insensitive/)       | Mixed-case keywords, identifiers, and APIs   | Display  |
| [text-and-math](language/text-and-math/)             | Text composition and math functions          | Display  |
| [text-search](language/text-search/)                 | One-based text search and slicing            | Display  |
| [compound-arithmetic](language/compound-arithmetic/) | Compound assignment and fractional division  | Display  |
| [byte-logic](language/byte-logic/)                   | Byte masks and hexadecimal formatting        | Display  |
| [byte-workbench](language/byte-workbench/)           | Hex/binary conversion, bit tests, and shifts | Display  |
| [local-functions](language/local-functions/)         | Define and call a local Function             | Display  |
| [display-function](language/display-function/)       | Typed numeric and text input parameters      | Display  |
| [function-outputs](language/function-outputs/)       | Typed output parameters                      | Display  |
| [output-pipeline](language/output-pipeline/)         | An out parameter feeds another Function      | Display  |

## Collections

| Example                                           | What it teaches                                         | Hardware |
| ------------------------------------------------- | ------------------------------------------------------- | -------- |
| [row-vector](collections/row-vector/)             | Fixed Rows and number Vectors                           | Display  |
| [row-statistics](collections/row-statistics/)     | Mean, minimum, and maximum of a Row                     | Display  |
| [row-lifecycle](collections/row-lifecycle/)       | Create, fill, resize, read, and delete a Row            | Display  |
| [vector-workbench](collections/vector-workbench/) | Initialize, sort, and multiply a Vector                 | Display  |
| [vector-toolkit](collections/vector-toolkit/)     | Text initialization, addition, sort, and matrix product | Display  |
| [matrix-product](collections/matrix-product/)     | Row-major 2×2 matrix multiplication                     | Display  |

## Algorithms

| Example                                              | What it teaches                                         | Hardware |
| ---------------------------------------------------- | ------------------------------------------------------- | -------- |
| [euclidean-gcd](algorithms/euclidean-gcd/)           | Euclid's algorithm with a reusable Function             | Display  |
| [fibonacci-sequence](algorithms/fibonacci-sequence/) | State updates through a temporary variable              | Display  |
| [prime-count](algorithms/prime-count/)               | Trial division with nested loops and early exit         | Display  |
| [insertion-sort](algorithms/insertion-sort/)         | Zero-based insertion sort with duplicates and negatives | Display  |
| [recursive-hanoi](algorithms/recursive-hanoi/)       | Recursive divide and conquer on a visual board          | Display  |

## Concurrency

| Example                                               | What it teaches                                | Hardware        |
| ----------------------------------------------------- | ---------------------------------------------- | --------------- |
| [thread-mutex](concurrency/thread-mutex/)             | Background Sub, mutex, and yielding            | Display and LED |
| [shared-counters](concurrency/shared-counters/)       | Two worker threads with mutex-protected writes | Display         |
| [sort-and-heartbeat](concurrency/sort-and-heartbeat/) | Sort while a background worker runs            | Display         |

## Files

| Example                                   | What it teaches                         | Hardware                 |
| ----------------------------------------- | --------------------------------------- | ------------------------ |
| [file-round-trip](files/file-round-trip/) | Write and read an EV3 text file         | Display; writes one file |
| [binary-record](files/binary-record/)     | Write and read one binary byte          | Display; writes one file |
| [byte-sequence](files/byte-sequence/)     | Sequential byte reads, including zero   | Display; writes one file |
| [typed-record](files/typed-record/)       | Text, byte, and number array round trip | Display; writes one file |

## Mailboxes

| Example                                       | What it teaches                            | Hardware                        |
| --------------------------------------------- | ------------------------------------------ | ------------------------------- |
| [mailbox-local](mailboxes/mailbox-local/)     | Create a named inbox and poll it           | Optional second EV3             |
| [paired-receiver](mailboxes/paired-receiver/) | Receive text and numeric messages          | Two Bluetooth-paired EV3 bricks |
| [paired-sender](mailboxes/paired-sender/)     | Connect and send text and numeric messages | Two Bluetooth-paired EV3 bricks |

## Program

| Example                                           | What it teaches                                | Hardware        |
| ------------------------------------------------- | ---------------------------------------------- | --------------- |
| [program-end](program/program-end/)               | Explicitly end an EV3 program                  | Display         |
| [brick-status](program/brick-status/)             | Brick name, battery, time, and LED             | Display and LED |
| [battery-under-load](program/battery-under-load/) | Battery level, voltage, and current under load | Motor A         |

## Projects

| Example                                            | What it teaches                                      | Hardware                                 |
| -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| [include-settings](projects/include-settings/)     | One extension-free `Include` and shared values       | Motors A and D                           |
| [include-multiple](projects/include-multiple/)     | Multiple project-relative `.bpi` files               | Motor A                                  |
| [include-behaviors](projects/include-behaviors/)   | Two `.bpi` files share motor settings and RGB output | Medium motors A and B; color sensor on 1 |
| [import-functions](projects/import-functions/)     | Imported `.bpm` Function return value                | Display                                  |
| [import-module](projects/import-module/)           | A private helper from an imported module             | Display                                  |
| [import-calibration](projects/import-calibration/) | An imported Function clamps values to 0–100          | Display                                  |
| [nested-imports](projects/nested-imports/)         | Includes plus a module importing another module      | Display                                  |

## Motors

| Example                                            | What it teaches                                | Hardware               |
| -------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| [motor-move](motors/motor-move/)                   | Blocking movement, delay, and brake            | Motors A and D         |
| [motor-start-stop](motors/motor-start-stop/)       | Start motors continuously, then stop safely    | Motors A and D         |
| [motor-reverse](motors/motor-reverse/)             | Negative speed and reverse movement            | Motor A                |
| [motor-sequence](motors/motor-sequence/)           | Two blocking moves in sequence                 | Motors A and D         |
| [motor-counter](motors/motor-counter/)             | Read a motor encoder and branch with `If`      | Motor A                |
| [motor-steer-sync](motors/motor-steer-sync/)       | Coordinated steering and synchronized movement | Motors A and D         |
| [motor-schedule](motors/motor-schedule/)           | A ramped, scheduled movement                   | Motors A and D         |
| [power-ramp](motors/power-ramp/)                   | Bounded open-loop power steps                  | Motor A                |
| [encoder-profile](motors/encoder-profile/)         | Record encoder samples during a power schedule | Motor A                |
| [polarity-feedback](motors/polarity-feedback/)     | Invert polarity, read feedback, and restore    | Motor A                |
| [steering-lifecycle](motors/steering-lifecycle/)   | Continuous, blocking, and scheduled steering   | Matched motors A and D |
| [sync-lifecycle](motors/sync-lifecycle/)           | Continuous, blocking, and scheduled sync       | Matched motors A and D |
| [paired-trajectories](motors/paired-trajectories/) | Schedule two motors before waiting             | Motors A and D         |

## Sensors

| Example                                                   | What it teaches                               | Hardware                              |
| --------------------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| [sensor-threshold](sensors/sensor-threshold/)             | Wait, read a percentage, and select feedback  | Touch sensor on 1                     |
| [sensor-sampling](sensors/sensor-sampling/)               | Repeated sampling in a finite loop            | Touch sensor on 1                     |
| [color-sensor](sensors/color-sensor/)                     | Detected color in Color mode                  | Color sensor on 1                     |
| [gyro-sensor](sensors/gyro-sensor/)                       | Rotation angle in Angle mode                  | Gyro sensor on 1                      |
| [sensor-details](sensors/sensor-details/)                 | Sensor identity, mode, and raw values         | A sensor on 4                         |
| [raw-and-mode](sensors/raw-and-mode/)                     | Choose a mode, then read a raw channel        | Color sensor on 4                     |
| [three-zone-light](sensors/three-zone-light/)             | Two reflected-light threshold boundaries      | Color sensor on 1                     |
| [five-sample-average](sensors/five-sample-average/)       | Average five samples with a float accumulator | Color sensor on 1                     |
| [mode-inspector](sensors/mode-inspector/)                 | Identity, busy flag, and mode switching       | Color sensor on 1                     |
| [raw-channel-dashboard](sensors/raw-channel-dashboard/)   | Percent and multichannel raw values           | Color sensor on 1                     |
| [rgb-function](sensors/rgb-function/)                     | RGB mode with three output channels           | Color sensor on 1                     |
| [port-raw-access](sensors/port-raw-access/)               | Port-specific `Sensor1`–`Sensor4` raw reads   | Color sensor on 1; raw sensors on 2–4 |
| [touch-port-grid](sensors/touch-port-grid/)               | Read and draw all four input ports            | Touch sensors on 1–4                  |
| [i2c-registers](sensors/i2c-registers/)                   | Read a documented I2C register                | Documented I2C device on 1            |
| [i2c-register-workbench](sensors/i2c-register-workbench/) | Single and multiple register reads and writes | Custom I2C test device on 1           |

## HiTechnic

| Example                                             | What it teaches                              | Hardware                                 |
| --------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| [compass-heading](hitechnic/compass-heading/)       | Two-byte heading and signed wraparound error | HiTechnic Compass on 1                   |
| [infrared-direction](hitechnic/infrared-direction/) | AC direction and sector strength             | HiTechnic IRSeeker V2 on 2 and IR beacon |

## Daisy chain

| Example                                             | What it teaches                  | Hardware                     |
| --------------------------------------------------- | -------------------------------- | ---------------------------- |
| [two-brick-control](daisy-chain/two-brick-control/) | Layer-aware input 5 and motor A2 | Two daisy-chained EV3 bricks |

## Capstones

| Example                                                   | What it teaches                               | Hardware                          |
| --------------------------------------------------------- | --------------------------------------------- | --------------------------------- |
| [button-car](capstones/button-car/)                       | Drive a two-motor car with brick buttons      | Brick buttons; motors A and D     |
| [sensor-dashboard](capstones/sensor-dashboard/)           | A visual sensor percentage dashboard          | Color sensor on 1                 |
| [obstacle-rover](capstones/obstacle-rover/)               | Stop a rover when the touch sensor is pressed | Touch sensor on 1; motors A and D |
| [scheduled-action-loop](capstones/scheduled-action-loop/) | Sensor-driven motor actions with LED feedback | Touch sensor on 1; motor A        |

## Simulation

| Example                                                | What it teaches                                   | Hardware                 |
| ------------------------------------------------------ | ------------------------------------------------- | ------------------------ |
| [differential-route](simulation/differential-route/)   | Encoder travel and a 90° turn                     | Simulator; no EV3 needed |
| [omni-lateral](simulation/omni-lateral/)               | Lateral and forward motion with four omni wheels  | Simulator; no EV3 needed |
| [vision-search](simulation/vision-search/)             | Synthetic vision with a sensor identity guard     | Simulator; no EV3 needed |
| [pixy2-search](simulation/pixy2-search/)               | Pixy2 LEGO I2C signature counts and blocks        | Simulator; no EV3 needed |
| [motor-shooter](simulation/motor-shooter/)             | A motor stroke launches a nearby ball             | Simulator; no EV3 needed |
| [mailbox-cooperation](simulation/mailbox-cooperation/) | Two entries exchange a target and acknowledgement | Simulator; no EV3 needed |

## Benchmarks

| Example                                          | What it teaches                                      | Hardware |
| ------------------------------------------------ | ---------------------------------------------------- | -------- |
| [compute-and-draw](benchmarks/compute-and-draw/) | Arithmetic, trigonometry, sort, matrices, and timing | Display  |
