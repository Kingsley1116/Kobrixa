# Stage 3 contract freeze

Status: ordered T0 in progress; no feature branch may start.
Planning baseline: b7953e639182117865f5a46f71828e724b7aa334.
Final F: absent until all three ordered portions pass their contract gates.
Order: 3A-T0 → 3B1-T0 → 3B2-T0 on feat/plugin-system-stage-3.
Published API during freeze: 1.4.0. No new runtime route or provider enabled.

Successor ownership:
- A-T1: protocol device-types, business-result, device-methods, device-limits, events, device-contract.test, device-broker-v1 fixtures.
- A-T2: device-broker/provider, broker-port, contract.test.
- A-T3: runtime/device-resources and test; device-broker/journal-port, recovery-port and resource-participant.
- A-T5: device-broker/legacy-device and legacy-files.
- A-T2 also receives device-broker/fake-provider.
- A-T1 also receives H-P peer/errors, JS events and Python _events scaffolds; H-P common business-result/events and direct tests transfer A-T1 → B1-T1 only after P150 → B2-T8 only after P160, with stopped-owner/path/SHA receipts.
- A-T4: device/io-boundary; device-providers/ev3/provider.
- A-T6: device-broker/authority-port.
- A-T7: device-broker/rpc-router.
- A-T8: runtime/profile-writer-lock and device-broker/lifecycle-coordinator.
- AM-13 compatibility receipts: H-R compiler-resolution.test.ts and language-service-conformance.test.ts; H-D workspace/compiler-chain.test.ts and language/language-provider.integration.test.ts. Record prior owner stopped, exact path and SHA before each slice; mandatory policy/required/canToggle fields stay mandatory.
- AM-32 corrected paths: only test-fixtures/device-broker-v1/{valid,invalid,maximum}.json, device-broker/fake-provider.ts and its test; reports remain under docs/superpowers/plans/.
- AM-31 fixture outer format and AM-15 future type projections are frozen; no future runtime registry publication at F.

Required early slices before P150 acceptance:
- D150 (A-T8 with early B1-T5, H-D): real CoreActionLedger, controller/state/session/core-recovery wiring, trusted stop/Disconnect, renewal IPC, and required-policy workspace/compiler fixtures.
- R150 (B1-T3, H-R): builtin own-property provider rejection, shared errors re-export, channel owner/generation and device participant hooks, optional provider source policy.
- K150 (B1-T4, H-K): builtin:kobrixa.device-ev3 / kobrixa.device-ev3 allowlist factory and provider-only source registration.
- V150 (B1-T8, H-V): legacy device/battery/file/execution bridge composition.
- H-I (A-T10): dependency/build/test wiring, actual smoke and bilingual documentation.

The controller appends exact per-file B1/B2 successor rows and a verification record.
After the three portions are committed, append Final F: followed by the actual
40-character SHA from git rev-parse HEAD in a separate receipt commit. F names
the contract commit, never the receipt commit itself. Verify git merge-base
--is-ancestor F HEAD before every feature worktree starts.

Open gates: D150/R150/K150/V150 real integration, actual Electron/stdio/installed
transport, real journal/authority/provider, hardware, X-T1 real persistence drain.
No gate is marked passed by type-only declarations or frozen doubles.

## 3A-T0 amendment receipt (pending successors)

Execution branch: `feat/plugin-3-t0`, as explicitly directed by the controller;
this supersedes the historical branch precondition above. No commit or final F
SHA is recorded by this implementer. No feature preflight is authorized yet.

BM-01 defining modules and single assembly owner:

| Defining module | Frozen exports / next writer |
| --- | --- |
| protocol/device-types.ts | Identity, device DTOs, handle/counter schema declarations; A-T1 |
| protocol/device-methods.ts | DeviceFailureDetail (sole definition), DeviceRequestMap; A-T1 |
| protocol/business-result.ts, errors.ts | BusinessResult, cumulative type-only errors/resources and failure schema declarations; A-T1 |
| protocol/events.ts | EventEnvelope, Stage3EventData; A-T1, then stopped H-P handoffs |
| runtime/device-resources.ts | Principal, journal DTOs, DeviceRecoverySnapshot/DeviceRecoveryPort (sole definitions), lifetimes, DeviceRequirement, CommonEventLedgerPort, channel attachment; A-T3 |
| runtime/profile-writer-lock.ts | ProfileWriterLock; A-T8 |
| runtime/core-actions.ts | CoreActionReference, validation, CoreWindowScope and device-current-stop target; B1-T0 forward definition |
| runtime/builtin-launch.ts | Builtin launch contracts; B1-T0 forward definition |
| runtime/ui-lifecycle.ts | Stage3RuntimePorts, Stage3HostAttachment, Stage3ChannelContext, Stage3ChannelBinding, UiRuntimeAttachment, OwnerRetirement; B1-T0 forward definition |
| runtime/ui-subscriptions.ts | UiEventLedgerPort; B1-T0 forward definition |
| runtime/ui-host-ports.ts | Explicit PluginUiBridge, UiCatalogPort, UiBridgeEvent, FoundationDiagnostics, FoundationCounters, FoundationDiagnosticEvent; B1-T0 forward definition |
| runtime/persistence-participant.ts | Shared persistence participant types; B2-T0 forward definition |
| runtime/settings-form-port.ts | SettingsFormBinding, SettingsFormPort, BoundSettingsService, ContributedSettingsForm, SettingsFieldMap; B2-T0 forward definition |
| runtime/index.ts | **H-R, B2-T0 Step 3 only**: assemble all type-only exports after defining modules exist, then rebuild and check package-root consumers |

All paths above are under `packages/plugin-protocol/src/` or
`packages/plugin-runtime/src/` as indicated. No A-T0 barrel writer was added.
The desktop journal/recovery/broker ports re-export the runtime recovery DTOs;
the runtime re-exports the protocol DeviceFailureDetail. F/P150 equality tests
remain in desktop device-broker/contract.test.ts, including package-root imports.

`apps/desktop/src/main/device-broker/lifecycle-coordinator.ts` now declares
DesktopFoundationOptions, DesktopFoundation, createDesktopFoundation,
DesktopMainCompositionInput, DesktopMainComposition, CoordinatorInput and
LifecycleCoordinator. BM-03 attachProvider, BM-06 normalized retirement and
BM-18 side-effect-free composition signatures are frozen. The stopped-owner
handoff for this file/test and main/plugins/controller.ts/test is
D150 → D160 → D170; those later slices preserve the same composition contracts.
Main/plugins/core-recovery.ts is the B1-T0 forward CoreActionLedger definition.

BM-09 RecoveryDriver.wallNow is distinct from monotonic time. BM-16 ledger
diagnostics is read-only. All factory exports remain declarations; no provider,
transport, writer, process or new wire method is activated.

T0 unavailable adapters: RequestContext.afterReply has its required signature,
but abandons and throws until A-T1 implements the real publication barrier;
Python event entrypoints raise NotImplementedError. A-T1 replaces the temporary
peer scaffold and its explicit T0-only test with publication/cancellation/send
failure tests. Neither adapter reports success. Stage3EventData freezes exact
payload types; future UI/settings validators are completed by their domain
owners, and A-T1 assembles schema inference without publishing future kinds.

Controller gates still pending: B1/B2 defining modules, B2/H-R barrel assembly,
protocol/runtime/SDK/device builds, runtime contract typechecks, desktop contract
tests and check:desktop. Local Vitest execution is not proof of TypeScript
expectTypeOf assertions or completed F. Record the actual assembly commit and
all per-file stopped-owner SHA receipts before recording final F.
