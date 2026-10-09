# Bytecode test cases

Run `pnpm test:bytecode` from the repository root. This builds the compiler packages before Node's test runner executes the `*.test.mjs` files. The same suite is included in `pnpm test` and CI.

- `compiler-regressions.test.mjs`: individually named source-to-RBF execution regressions.
- `optimization.test.mjs`: optimized/unoptimized execution comparisons, function pruning and retained roots, nested threads, scalar copy forwarding, temporary/scratch-memory bounds, branch/loop liveness, deterministic output, and diagnostics in unused functions.
- `array-lifetime.test.mjs`: repeated sensor polling under a 250-array budget, transfer-buffer cleanup, and preservation of arrays that escape a helper.
- `i2c-bytecode.test.mjs`: firmware reply reversal, Pixy2 signature/largest-block/RGB layouts, unsigned byte values, and single/full-buffer reads.
- `example-bytecode.test.mjs`: literal-byte VM checks for floating-point moves, native call descriptor alignment, worker lifetime, numeric narrowing, shifts, trigonometry, and subcall exclusion.
- `diagnostic-examples.test.mjs`: every corrected Basic Plus example in the shared diagnostic catalog compiles through the frontend and backend to a structurally valid native RBF.
- `robot-bytecode.test.mjs`: project initialization, buttons, scheduling, gyro, camera, steering and odometry checks.
- `movement-bytecode.test.mjs`: 5,460 steering combinations, nine repeated calls, two turns and four timed moves.

All tests run offline using the independent opcode schema in `fixtures/opcodes.json`; see `fixtures/PROVENANCE.md`. Shared helpers perform no tests or builds when imported and do not read CLI arguments.

The VM's optional `maxArrayHandles` budget catches allocation leaks, reuses released handles, and rejects double deletion. The 250-array test budget is an upper bound derived from firmware `MAX_HANDLES`; a brick also uses handles for other memory pools and files. This is a resource regression check, not a full firmware memory model.

Robot-control and movement tests compile the checked-in `fixtures/robot-control` project. They run by default without environment variables or external source files. Builds use temporary directories that are removed after compilation. Device operations use deterministic stubs.

The robot fixture explicitly retains the movement and math helpers that tests invoke directly through the VM. Other optimizations remain enabled, and function IDs are resolved from the emitted listing.

The report-producing CLI remains available through `tools/run-example-bytecode.mjs`. It accepts external firmware tables and an output directory.
