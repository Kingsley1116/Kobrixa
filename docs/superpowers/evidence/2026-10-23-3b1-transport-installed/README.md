# 3B1 transport and installed payload evidence

These are completed **partial gates**, not P160 or Stage 3 acceptance.

| Gate                                                | Tested source                                     | Result                                                                    |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| Actual Electron MessagePort JS / Python stdio       | `30d8593fb2bf41c0252e13ae24a93734f1c4656a`, clean | Exit 0; both original processes exited; no remaining PIDs                 |
| Formal release builder, fixture package             | `c319a5a9b5209030296c32c66d1e4b7352ace275`, clean | Exit 0; real builtin resource index and ASAR unpack paths                 |
| Synthetic installed host using that release payload | `c319a5a9b5209030296c32c66d1e4b7352ace275`, clean | Exit 0; empty PATH, no NODE_PATH, unrelated cwd; actual plugin PID exited |
| Missing / hash-corrupt installed entry              | Same synthetic installed host                     | Both rejected by the real resolver before launch                          |

The JSON files contain original wire messages, actual PIDs, runtime versions and artifact hashes. Logs retain the commands' output. This host was macOS arm64; Electron 44.7.0, embedded Node 24.21.0. Local packages use ad-hoc signatures, not Developer ID or notarization. Neither command publishes.

The transport host mocks `ui/instances` and uses a synthetic panel binding solely to verify SDK protocol behavior. It does not establish real UI, authority, motion, persistence, load or hardware acceptance. The installed run uses a synthetic main host and the **unmodified release-built plugin leaf**. It does not establish the source-free, offline installation gate: OS-level denial of network and repository access was not enabled. No 3C motor implementation is being claimed.

## Packaging rulings

The repository now packages through `tools/release/build-desktop.mjs` and electron-builder. Earlier K160 wiring covered Forge only. Both paths now share the builtin build list, validator and unpack rule; the release path builds each leaf and validates the staged output before packaging. Native dependencies and their license notices resolve from node-hid's installed dependency graph, including unhoisted pnpm packages. No dependency installation or lockfile change was needed.

The original planned `acceptance-builtin` identity is deliberately absent from the production resolver's allowlist. The installed fixture therefore uses the existing reserved `motor-test` / `kobrixa.motor-test` identity without registering a product. This does **not** broaden the allowlist. Fixture builds fail if a real delivered motor payload would be overwritten. Each altered synthetic macOS host is locally re-signed and verified; the original packaged app and OS security settings remain unchanged.

## Reproduction

With existing dependencies and package dist built, from the B1 checkout:

```sh
export pnpm_config_pm_on_fail=ignore pnpm_config_verify_deps_before_run=false
node tests/desktop/declarative-ui-run.mjs --transport-only
KOBRIXA_PLUGIN_FIXTURE_BUILD=1 pnpm --filter @kobrixa/desktop package
node tests/desktop/builtin-process-installed.mjs
```

The two Electron commands require a local native execution environment. Pure helper tests explicitly skip actual receipt validation unless given a retained receipt; that skip is never reported as installed acceptance.

Supporting checks: 50 packaging/index/fixture/launch Vitest cases; 35 release Node cases; desktop type check and scoped lint passed. The full desktop run before this packaging-only change passed 2447 tests with 9 existing skips. Independent reviews of D160, V160 and the later packaging changes remain pending due to agent quota. Browser, native interaction/race, performance, real persistence and remaining cross-platform/manual gates are still outstanding.

Follow-up after fixture stale-binding handling at clean `a8cd10f4b8f31e7796e24578cc73ea92ca08695e`: `current-transport.json`/`.txt` retains real JS MessagePort/Python stdio receipts, six passing assertions with no skips and no remaining consumer PIDs. This is still mock-UI transport parity, not renderer/motion evidence.
