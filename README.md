# Kobrixa IDE

**Code motion. Build ideas.**

Kobrixa IDE is an open-source, cross-platform development environment for programming LEGO® MINDSTORMS® EV3 robots. It is designed for students and makers who want a focused path from source code to a program running on a physical EV3 brick.

> [繁體中文版](README.zh-TW.md)

## Project status

**v1 candidate implementation.** The repository contains a buildable IDE, compiler pipeline, EV3 image backend, and USB/Wi-Fi device services. Basic Plus compatibility coverage and the three-platform physical-brick matrix remain release gates.

| Capability                           | Status                                |
| ------------------------------------ | ------------------------------------- |
| Basic Plus (`.bp`) frontend          | v1 candidate                          |
| Native EV3 `.rbf` output             | v1 candidate                          |
| USB HID on Windows, macOS, and Linux | Candidate; physical matrix pending    |
| Wi-Fi on Windows, macOS, and Linux   | Candidate; physical matrix pending    |
| Installers and automatic updates     | Implemented; availability per Release |
| Python frontend                      | Planned after v1                      |
| TypeScript frontend                  | Planned after Python                  |
| C++ frontend                         | Planned after TypeScript              |
| Bluetooth, simulator, block editor   | Long-term                             |

No planned capability should be interpreted as already available.

## Product direction

The v1 workflow is intentionally narrow:

```text
Edit .bp source
      ↓
Compile to KobrixaIR
      ↓
Generate native EV3 bytecode (.rbf)
      ↓
Upload over USB or Wi-Fi
      ↓
Run on the EV3 brick
```

Kobrixa will use a clean-room implementation to provide behavioral compatibility with commonly used legacy `.bp` programs. Compatibility means that a supported program runs without source changes and produces equivalent observable behavior; byte-for-byte equality with another compiler's `.rbf` output is not required.

Later language frontends will share the same typed intermediate representation and EV3 backend. Kobrixa will parse as much standard Python, TypeScript, and C++ syntax as practical, but the original EV3 runtime cannot provide their complete desktop runtimes or standard libraries. Features that cannot be represented safely must produce explicit compile-time diagnostics.

## Technology

- Electron desktop shell
- React and TypeScript renderer
- Monaco Editor
- Node.js and TypeScript compiler core, EV3 backend, and device services
- Native EV3 VM as the v1 execution target
- Apache License 2.0

Node.js and TypeScript describe Kobrixa's implementation stack. C++ remains a separately planned source-language frontend for user programs after the TypeScript frontend.

## Documentation

- [Code signing policy](docs/en/code-signing.md)

- [Product specification](docs/en/product.md)
- [Architecture and public contracts](docs/en/architecture.md)
- [Language support policy](docs/en/language-support.md)
- [Device and platform support](docs/en/device-support.md)
- [Roadmap](docs/en/roadmap.md)
- [Installation and recovery](docs/en/installation.md)
- [Examples](examples/README.md)
- [Contributing](CONTRIBUTING.md)

## Repository layout

```text
apps/desktop/           Electron main/preload and React renderer
packages/compiler/      Compiler orchestration and diagnostics
packages/ir/            KobrixaIR definitions and validation
packages/backend-ev3/   EV3 bytecode and .rbf generation
packages/device/        USB and Wi-Fi transports
frontends/basic-plus/   v1 Basic Plus frontend
tests/bytecode/         Offline bytecode and behavioral regression tests
tests/hardware/         Manual EV3 hardware acceptance scripts
docs/                   Product and engineering documentation
```

These components are implemented in the repository. Published packages and their signing status are listed in [GitHub Releases](https://github.com/Kingsley1116/Kobrixa/releases); physical-platform acceptance is tracked separately in the device documentation.

## Legal and naming

Kobrixa is an independent project and is not affiliated with, endorsed by, or sponsored by the LEGO Group. LEGO, MINDSTORMS, and EV3 are trademarks of the LEGO Group.

The Apache-2.0 license in this repository applies only to original Kobrixa work. It does not grant rights to code, assets, documentation, trademarks, or other material owned by Clev3r, EV3Basic, the LEGO Group, or any other third party. Kobrixa must not copy Clev3r source code, visual assets, or documentation; compatibility work must be based on public behavior specifications and independently authored tests.

The name “Kobrixa” passed a basic web and package-name collision check during planning. This is not trademark clearance. Before public release, maintainers must perform appropriate trademark, repository, package-registry, social-handle, and domain checks.

## Contributing

Kobrixa welcomes specification review, independently authored compatibility cases, compiler work, device testing, and documentation improvements. Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing.

## License

Original Kobrixa work is licensed under the [Apache License 2.0](LICENSE).
