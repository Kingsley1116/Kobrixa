# Tests

Unit tests live alongside the source they cover in `apps/`, `packages/` and
`frontends/`. This directory contains cross-package execution tests and manual
hardware acceptance scripts.

```text
tests/
  bytecode/
    *.test.mjs       Offline tests run by Node's test runner
    support/         Shared compiler, VM and movement helpers
    fixtures/        Independent opcode schema and robot-control source project
  hardware/
    *.mjs            Manually invoked EV3 acceptance scripts
    fixtures/        Expected results for hardware example checks
```

| Command                                                              | Scope                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `pnpm test`                                                          | Package tests and the offline bytecode suite; also run in CI |
| `pnpm test:bytecode`                                                 | Build compiler packages and run the offline bytecode suite   |
| `pnpm test:hardware -- --transport=usb --artifact=/path/program.rbf` | Upload, run, stop and delete an artifact on a connected EV3  |

See [bytecode/README.md](bytecode/README.md) for offline coverage and
[hardware/README.md](hardware/README.md) for manual hardware setup.

Keep reusable helpers in `support/` and input data in `fixtures/` within the suite
that uses them. Each fixture must have a consuming test or script. Author test
sources and expectations independently; retain provenance notes for fixture data.
