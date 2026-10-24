# 3D D0 model and code-generation evidence

This receipt covers preparatory pure-model migration checks, not the Sensor Lab plugin, UI v2/API 1.8.0, native process or installed acceptance.

## Reviewed source

- `1612829`: actual legacy recording/profile schemas, CSV, chart reduction/extrema, and cursor selection compared with the new model. The cursor model was corrected to match the legacy later-input tie and inclusive 1500 ms cutoff. Six scoped files / 53 tests passed.
- `7788a44`: 44 additional English/Traditional Chinese differential cases invoke both the actual legacy `apps/desktop/src/shared/sensor-calibration.ts` generator and new `plugins/sensor-lab/src/model/calibration.ts` generator. Their programs run through Basic Plus frontend, IR validation, EV3 backend, bytecode decoder and VM. Six scoped files / 97 tests passed. An independent read-only reviewer reran all 97 successfully with no findings.

Code-generation comparisons retain full VM traces without normalization, outputs/errors, sensor metadata/readiness/mode operations, SI reads and motor operations. Inputs include nonzero sensor components, reversed calibration, zero endpoints, extrapolation, float32 rounding and large/small coefficients, missing/non-finite values, sensor-type mismatch, motor zeroing without resetting counts, and both locales. Literal expected numeric results supplement old/new equality. VM instrumentation observes operands and delegates to original instruction execution. Tests call the actual legacy exports; the new implementation is not its own comparison oracle.

## Execution

```sh
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
pnpm exec vitest run --config /private/tmp/sensor-lab-parity.vitest.mts --configLoader runner
```

The controller-local scoped config uses the desktop Node test environment, includes `src/builtin-features/sensor-lab/*.test.ts`, and resolves workspace packages to this checkout's source where dist is unavailable. This was a source-level test run, not proof of packaged dependency resolution. Scoped lint, formatting, TypeScript and diff checks also passed.

## Remaining D0 and dependency gates

Live public EV3 channel-to-legacy identity mapping is still a proposed contract awaiting the provider/protocol owners; no private catalog import was added to the plugin. VM results do not establish physical sensor or motor behavior. Native Lab source switching, subscriptions, recorder, persistence/imports, generic UI v2, status behavior, installed/source-denial and removal of the legacy Lab remain unimplemented or unverified. Foundation P160/P170/X-T1 and 3C source-denial/legacy-exit dependencies remain open, so this receipt does not authorize the API 1.8.0 freeze or mark D0/full stage complete.
