# Kobrixa IDE

**Code motion. Build ideas.**

Kobrixa IDE is an open-source desktop app for programming LEGO® MINDSTORMS® EV3 robots on Windows, macOS, and Linux. You write programs in Basic Plus (`.bp`), Kobrixa compiles them to native EV3 bytecode, and sends them to the brick over USB or Wi-Fi — no firmware replacement required.

[Download](https://github.com/Kingsley1116/Kobrixa/releases) · [Website](https://kobrixa.com) · [Examples](examples/README.md) · [Documentation](#documentation) · [繁體中文版](README.zh-TW.md)

## What you can do

- **Write Basic Plus** in a Monaco-based editor with diagnostics, formatting, and configurable keyboard shortcuts. Commonly used legacy `.bp` programs are intended to run without source changes ([language support](docs/en/language-support.md)).
- **Build and run on the EV3** — compile to a native `.rbf` program, upload over USB or Wi-Fi, and run it with one command (**Run on EV3**, F5). Browse and manage files on the brick.
- **Record sensor curves** — plot up to four sensor or motor-angle channels live, calibrate them, and compare saved recordings ([Sensor Lab](docs/en/sensor-lab.md)).
- **Test motors** — run motors A–D from **EV3 tools → Monitor** without writing a program ([motor testing](docs/en/motor-test.md)).
- **Collaborate in real time** — share an invite code to co-edit one project, chat, and hand over EV3 control; no account needed ([cloud collaboration](docs/en/collaboration.md)).
- **Stay up to date** — the app checks GitHub Releases and installs updates after confirmation ([installation and updates](docs/en/installation.md)).

## Quick start

### 1. Install

Download the file for your system from the latest [GitHub Release](https://github.com/Kingsley1116/Kobrixa/releases):

| Platform            | File                                    | How to install                                        |
| ------------------- | --------------------------------------- | ----------------------------------------------------- |
| Windows x64         | `Kobrixa-<version>-win32-x64-setup.exe` | Run the installer (installs for the current user)     |
| macOS Apple Silicon | `Kobrixa-<version>-darwin-arm64.dmg`    | Open the DMG and drag `Kobrixa.app` into Applications |
| Linux x64           | `Kobrixa-<version>-linux-x64.AppImage`  | Make the file executable (`chmod +x`), then launch it |

Candidate builds may be unsigned, so your operating system may show a warning. See the [code signing policy](docs/en/code-signing.md) and [installation guide](docs/en/installation.md) for checksum verification and updates. On Linux, USB access may need a [udev rule](docs/en/installation.md#usb).

### 2. Write a program

Choose **New project** (or **Open** one of the [examples](examples/README.md)) and enter:

```vb
' Show a greeting and a line on the EV3 display.
Folder "prjs" "Kobrixa"

LCD.Clear()
LCD.Text(1, 8, 18, 1, "Hello from Kobrixa")
LCD.Line(1, 8, 38, 165, 38)
LCD.Update()
Speaker.Tone(35, 440, 180)
Program.Delay(250)
```

This is [`examples/getting-started/hello-ev3`](examples/getting-started/hello-ev3/); it needs only the brick's display and speaker.

### 3. Connect and run

1. Turn on the EV3 and connect it by USB cable, or put it on the same Wi-Fi network as your computer.
2. Open the EV3 panel (**Show EV3 panel**, Ctrl/Cmd+Shift+E) and choose **Connect**.
3. Choose **Run on EV3** (F5). Kobrixa compiles, uploads, and starts the program.

Compile errors appear in the diagnostics panel (Ctrl/Cmd+J) with the exact line. Use **Build** (Ctrl/Cmd+Shift+B) to check a program without an EV3. Next, follow the [learning path](examples/LEARNING-PATH.md).

## Project status

Kobrixa is a **v1 release candidate** (currently `v0.1.0-v1-candidate.15`). Builds are available for trying out, but v1 is not final: full physical-EV3 testing on all three platforms and production code signing are still in progress.

| Capability                               | Status                           |
| ---------------------------------------- | -------------------------------- |
| Basic Plus (`.bp`) editor and compiler   | Available                        |
| Native EV3 `.rbf` output                 | Available                        |
| USB on Windows, macOS, and Linux         | Available; hardware testing      |
| Wi-Fi on Windows, macOS, and Linux       | Available; hardware testing      |
| EV3 file manager, Sensor Lab, motor test | Available                        |
| Cloud collaboration                      | Available (since candidate.12)   |
| Installers and automatic updates         | Available                        |
| Local robot simulator                    | In development; hidden in builds |
| Python frontend                          | Planned after v1                 |
| TypeScript frontend                      | Planned after Python             |
| C++ frontend                             | Planned after TypeScript         |
| Bluetooth, block editor                  | Long-term                        |

**Available** — included in current candidate builds. **Hardware testing** — implemented and tested automatically; the physical-brick acceptance matrix is not complete ([device support](docs/en/device-support.md)). **Planned / Long-term** — not available yet; see the [roadmap](docs/en/roadmap.md).

## How it works

```text
Edit .bp source
      ↓
Compile to KobrixaIR (typed intermediate representation)
      ↓
Generate native EV3 bytecode (.rbf)
      ↓
Upload over USB or Wi-Fi
      ↓
Run on the EV3 brick
```

Basic Plus compatibility is a clean-room implementation: a supported program should run without source changes and behave the same on the brick. Byte-for-byte equality with another compiler's `.rbf` output is not a goal.

Future Python, TypeScript, and C++ frontends will share the same KobrixaIR and EV3 backend. The EV3 runtime cannot host those languages' full standard libraries, so unsupported features will produce clear compile-time errors instead of silently misbehaving.

## Build from source

Requirements: Node.js 24 or later and pnpm 10.15.0 (pinned in `package.json`; `corepack enable` installs it).

```sh
pnpm install --frozen-lockfile
pnpm dev        # build shared packages and start the desktop app
pnpm test       # unit and bytecode tests
pnpm check      # type checks and lint
pnpm package    # unsigned desktop app for the current OS
```

On Debian/Ubuntu, install the native USB build dependencies first:

```sh
sudo apt-get install -y build-essential pkg-config libusb-1.0-0-dev libudev-dev
```

Product-specific checks (`pnpm check:desktop`, `pnpm check:web`, …), CI, and release steps are described in the [installation guide](docs/en/installation.md#development-build). Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Repository layout

```text
apps/desktop/              Electron main/preload and React renderer (the IDE)
apps/web/                  Website, online docs, and browser EV3 media tools (Cloudflare Worker)
apps/collab/               Cloud collaboration service (Cloudflare Worker)
packages/compiler/         Compiler orchestration and diagnostics
packages/ir/               KobrixaIR definitions and validation
packages/backend-ev3/      EV3 bytecode and .rbf generation
packages/device/           USB and Wi-Fi transports
packages/collab-protocol/  Collaboration wire contract
frontends/basic-plus/      Basic Plus language frontend
examples/                  Example projects and learning path
tests/                     Bytecode, desktop smoke, collaboration, and hardware tests
tools/                     Build, asset, CI, and release scripts
docs/                      Product and engineering documentation (en, zh-TW)
```

## Documentation

**Using Kobrixa**

- [Installation, updates, and recovery](docs/en/installation.md)
- [Keyboard shortcuts and settings](docs/en/keyboard-settings.md)
- [Device and platform support](docs/en/device-support.md)
- [Sensor Lab](docs/en/sensor-lab.md) · [Motor testing](docs/en/motor-test.md)
- [Cloud collaboration](docs/en/collaboration.md)
- [Examples](examples/README.md) and [learning path](examples/LEARNING-PATH.md)

**Project and engineering**

- [Product specification](docs/en/product.md)
- [Architecture and public contracts](docs/en/architecture.md)
- [Language support policy](docs/en/language-support.md)
- [Roadmap](docs/en/roadmap.md)
- [Code signing policy](docs/en/code-signing.md)

## Technology

Electron · React · TypeScript · Monaco Editor · Node.js. The compiler, EV3 backend, and device services are written in TypeScript; the v1 execution target is the stock EV3 VM. (C++ above refers to a future source language for user programs, not Kobrixa's implementation.)

## Legal and naming

Kobrixa is an independent project and is not affiliated with, endorsed by, or sponsored by the LEGO Group. LEGO, MINDSTORMS, and EV3 are trademarks of the LEGO Group.

The Apache-2.0 license in this repository applies only to original Kobrixa work. It does not grant rights to code, assets, documentation, trademarks, or other material owned by Clev3r, EV3Basic, the LEGO Group, or any other third party. Kobrixa must not copy Clev3r source code, visual assets, or documentation; compatibility work must be based on public behavior specifications and independently authored tests.

The name “Kobrixa” passed a basic web and package-name collision check during planning. This is not trademark clearance. Before public release, maintainers must perform appropriate trademark, repository, package-registry, social-handle, and domain checks.

## Contributing

Kobrixa welcomes specification review, independently authored compatibility cases, compiler work, device testing, and documentation improvements. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## License

Original Kobrixa work is licensed under the [Apache License 2.0](LICENSE).
