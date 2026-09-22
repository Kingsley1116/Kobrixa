# Bytecode test cases

Run `pnpm test:bytecode` from the repository root. This builds the compiler packages before Node's test runner executes the four `*.test.mjs` files. The same suite is included in `pnpm test` and CI.

- `compiler-regressions.test.mjs`: individually named source-to-RBF execution regressions.
- `example-bytecode.test.mjs`: literal-byte VM checks and all scenarios in the new-example and Clev3r-parity selection files.
- `robot-bytecode.test.mjs`: project initialization, buttons, scheduling, gyro, camera, steering and odometry checks.
- `movement-bytecode.test.mjs`: 5,460 steering combinations, nine repeated calls, two turns and four timed moves.

All tests run offline using the independent opcode schema in `fixtures/opcodes.json`; see `fixtures/PROVENANCE.md`. Shared helpers perform no tests or builds when imported and do not read CLI arguments.

Robot-control and movement tests compile the checked-in `fixtures/robot-control` project. They run by default without environment variables or external source files. Builds use temporary directories that are removed after compilation. Device operations use deterministic stubs.

The report-producing CLI remains available through `tools/run-example-bytecode.mjs` and the existing `pnpm examples:audit` / `pnpm examples:parity:audit` commands. Those commands still accept external firmware tables and an output directory.
