# Language support policy

## Shared rule

All source languages compile through a frontend into validated `KobrixaIR`, then through the same EV3 backend into native `.rbf`. A frontend may not silently reinterpret an unsupported feature. It must emit a stable, actionable compile-time diagnostic.

Basic Plus is the only implemented source frontend. The project manifest currently accepts `language: "bp"`; Python, TypeScript and C++ remain roadmap items. Desktop code signing authenticates the application distribution and does not change the languages accepted by the compiler or certify a program's hardware behavior.

“As complete as practical” means broad source syntax acceptance where semantics can be represented on the EV3 VM. It does not mean that Kobrixa embeds the full CPython, JavaScript, Node.js, browser, C++, or operating-system runtime in `.rbf`.

## Basic Plus (`.bp`) — v1

The clean-room frontend targets behavioral compatibility with supported legacy programs, including:

- Variables, arrays, expressions, strings, numbers, and Boolean conventions
- `If`/`ElseIf`/`Else`, loops, labels, and supported control flow
- Subs, functions, parameters, and `Return`
- Includes, modules, properties, and supported resource declarations
- Supported EV3 motor, sensor, display, speaker, button, file, mailbox, and program APIs

Compatibility means the original source runs without modification and has equivalent observable behavior on the reference brick. Whitespace, generated listings, instruction layout, and `.rbf` bytes may differ.

Boolean contexts accept both bare `true` / `false` literals and the legacy quoted forms `"True"` / `"False"`, case-insensitively. Quoted values are converted only where a Boolean is required, such as an `If` or `While` condition, `And` / `Or` / `Not`, or a Boolean EV3 API parameter. In text contexts, `"True"` remains ordinary displayable text.

The source frontend accepts the documented Clev3r keyword forms, including `import`, `folder`, `private`, typed `in` / `out` function parameters, and `break` / `continue`. It also accepts the documented `++`, `--`, `+=`, `-=`, `*=`, and `/=` assignment operators. Imports resolve project-relative `.bpm` files, while includes resolve `.bpi` files.

Compatibility is established from public behavior specifications and independently written cases. Public Help may be consulted for externally visible syntax and behavior, but CLEV3R source, documentation text, assets, generated output, and protected implementation expression are not copied into Kobrixa.

## Python — planned after v1

The frontend will aim to parse standard Python syntax and statically lower features that have defined EV3 semantics. Dynamic imports, runtime code generation, reflection-heavy behavior, native extensions, and most desktop standard-library modules are outside the native EV3 target. Unsupported features produce diagnostics that name the feature and suggest an EV3-compatible alternative when one exists.

## TypeScript — planned after Python

The frontend will use TypeScript syntax and static type information where available. It will not provide a browser DOM, Node.js APIs, dynamic module loading, `eval`, or an unrestricted JavaScript runtime. Supported constructs lower directly to typed IR rather than shipping a JavaScript engine.

## C++ — planned after TypeScript

This is a user-facing source-language frontend, not Kobrixa's implementation language; the compiler and desktop services are implemented with Node.js and TypeScript.

The frontend will target a documented freestanding EV3 profile. Host operating-system APIs, dynamic libraries, inline assembly, exceptions, RTTI, and unrestricted allocation are not guaranteed. Supported source lowers to IR; it is not compiled into arbitrary native ARM code hidden inside `.rbf`.

## Diagnostics policy

Diagnostic codes remain stable within a major version and use namespaces such as `BP`, `PY`, `TS`, `CPP`, `IR`, and `EV3`. At minimum, diagnostics cover syntax errors, unresolved names, type errors, unsupported features, invalid EV3 API calls, resource limits, and backend failures.

An unsupported feature is an error, never a warning followed by altered execution. Diagnostics include a precise source range and, where possible, a remediation note.

## Compatibility test policy

- Valid fixtures verify observable output, motor commands, sensor interaction, files, display operations, and exit behavior.
- Invalid fixtures verify stable codes and source ranges.
- Each regression gets the smallest independently authored fixture that reproduces it.
- Reference-brick tests define behavior where emulation is insufficient.
- Deterministic compiler tests may compare Kobrixa outputs across builds; they do not require equality with third-party compiler bytes.

## Numeric returns and text boundaries

Division (`/`) produces a floating-point result even with integer operands: `7 / 2` is `3.5`. All numeric return branches in a function share one inferred representation; a floating-point branch widens integer branches. Integer and Boolean returns use their matching EV3 call parameter widths. Incompatible return kinds report `BP2010`.

Text search and slicing use one-based positions. `Text.GetIndexOf` returns zero for a missing match; `Text.GetSubText` truncates the requested length at the source end and returns empty text for an invalid start or nonpositive length. A successful search branches on the firmware string equality result. Executable cases and bytecode expectations are in the [new example curriculum](https://github.com/Kingsley1116/Kobrixa/blob/main/examples/NEW-EXAMPLES.md).

## Example-driven runtime support

The [expanded curriculum](https://github.com/Kingsley1116/Kobrixa/blob/main/examples/CLEV3R-PARITY.md) records examples and bytecode expectations for these behaviors:

- Recursive call groups support 32 simultaneous frames and stop explicitly on overflow; native function objects are not reentrant.
- Mutex acquisition is serialized through a shared native subcall.
- Basic Plus trigonometric APIs use radians and convert to/from EV3 native degrees.
- Byte, I²C and file byte values preserve the 0–255 range.
- `Folder` in the entry source selects internal or SD deployment and runtime paths.

Automated compilation and bytecode checks establish only their tested properties. Physical observations and remaining limitations are recorded separately in the [hardware acceptance notes](https://github.com/Kingsley1116/Kobrixa/blob/main/examples/HARDWARE-ACCEPTANCE.md).
