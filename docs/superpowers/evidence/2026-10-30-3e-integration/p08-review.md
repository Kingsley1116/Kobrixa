# P08 independent provider review

Verdict: **no actionable findings** in the four-file diff against `9027984`, under the explicitly adopted logical-observation-slot semantics. Read-only review; no product changes and no review of my E4 fix.

## Scope

- apps/desktop/src/main/device-providers/ev3/catalog.ts
- apps/desktop/src/main/device-providers/ev3/catalog.test.ts
- apps/desktop/src/main/device-providers/ev3/provider.ts
- apps/desktop/src/main/device-providers/ev3/broker-integration.test.ts

Read the final P08 semantic sections in the 3E plan and 3E/3A design documents. Supporting source inspection covered existing protocol types/schemas, provider/native mode preflight, broker reservation checks and Sensor Lab preview. The reviewed production delta is the zero-value slot loop and the two non-ready mode guards; the remaining diff is regression coverage and the component-removal fixture adjustment.

## Evidence

- **Unchanged nullable contract:** ChannelDefinition retains component 0..7 and its actual ready/empty/initializing/unknown/error state. TelemetryFrame values already permit number|null. No public field, version or schema change is used. Protocol device-types.ts/device-methods.ts, native monitor.ts and broker reservations.ts have no diff against the requested base.
- **Bounds and absence:** catalog.ts iterates only actually supplied inputs. Each contributes max(1, values.length) slots; existing checks limit inputs to four, values per input to eight, and require four outputs. Thus the maximum remains 4×8+4+2=38. No row is added for an input absent from the provider reading. Nonempty component numbering is unchanged.
- **No invented numeric measurement:** existing frame() looks up the actual component and maps absent/nonfinite values to null. Zero-value inputs retain actual port/type/mode/name/state metadata; no empty/ready inference or numeric zero substitution is introduced. The tests exercise all five states, ten-channel zero-value catalogs, numeric transition, multiple components, and actual disappearance.
- **Identity/revision:** the unchanged metadata signature and host identify/observeProviderSources path remain authoritative. Same-metadata slot0 null→numeric does not change catalog identity, consistent with the ruling. Additional/removed components and metadata changes update the catalog; real-broker tests verify old-handle rejection, increased source revision and reservation ending on unit replacement. The prior component-removal test now starts with components0+1 and removes component1; removing values alone no longer removes logical slot0, so this is the appropriate changed oracle rather than weakened removal coverage.
- **Non-ready mode I/O:** provider query/set check source.state==='ready' before dispatching readInputModes or even the set-path readMonitor preflight. The new real-broker cases verify empty/initializing/unknown/error reject both mode operations and recording, with no mode query/write calls. Existing revision and host authority checks remain in place.
- **Native safety retained:** ready mode set still performs readMonitor, continuation assertion, stopped-program validation and catalog-revision comparison before native setInputMode. Existing native monitor code still validates supported sensor/mode and firmware-side program/type/connection/busy/mode-count guards, then observes readiness with its original deadline. Ready+null does not skip any of these boundaries. These checks were inspected, not executed against hardware.
- **Recording versus measurement:** ready+null is deliberately accepted as a nullable recording gap; non-ready channels remain rejected by reservation admission. The new broker test verifies a null first frame and source-change termination. Sensor Lab freshReading independently requires a finite number and rejects null, so Capture/Zero does not turn the logical slot into a calibration sample.

## Independently executed verification

Command (cwd E, D installed executable and existing E aliases):

`/Users/kingsley/.codex/worktrees/plugin-3d/Kobrixa/node_modules/.bin/vitest run --config /private/tmp/e5-p08-vitest.config.mjs -t 'zero-value|ready logical|F12 maximum|unpublished replacement|Capture/Zero|AM-06'`

**18 passed, 58 intentionally filtered/skipped, 4 files; exit 0.** Log: `/private/tmp/e5-p08-review-tests.log`.

This includes the new zero-value/non-ready/null-reservation tests, existing maximum catalog bound and unpublished identity replacement cases, the provider read/mode snapshot sentinel case, and Lab finite/null Capture/Zero coverage. No extra temporary probe was necessary.

Controller's prior full result remains **75 passed / 1 failed out of 76** in `/private/tmp/e5-p08.log`. Its transport-retirement failure is explicitly Archimedes's broker task; it was not selected or re-audited here. Prior types/lint PASS are controller evidence, not independently rerun. This report does not claim that unrelated failing suite is green, nor native/product/installed acceptance.

## Reviewed hashes / stopped receipt

- catalog.ts: `3df2d98e8b3f5a553275d87ac2c9924650a1138081a5721bae5280c718841d79`
- catalog.test.ts: `b4634d6a78975939b7d7046790f54bbc27ef5e30676588a4f63b4a7c5ae9f69d`
- provider.ts: `7789b505cf25f89395c1b477e32d6c96e3142000bcff1d839107eb867986ac2a`
- broker-integration.test.ts: `75128002df9d0230ef46a1a0707c70b505c5275dbb512d94d820d46da66f9a2c`

Only this report and its /private/tmp test log were written. No E file edits, commits, installations, native execution or shared builds. E6/native/public harness work has not been started.
