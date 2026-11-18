# E5 coordinated cutover — independent read-only review

Result: **No new actionable findings** in the bounded controller-owned diff against 03e6d49. This is a source/evidence review, not full product acceptance. No product files were edited; the nine E5 adoption files remain stopped. Their hashes were checked only, not reviewed; differences from the stopped receipt: [].

## Scope

- `apps/desktop/src/renderer/app.tsx`
- `apps/desktop/src/renderer/settings/settings-state.ts`
- `apps/desktop/src/renderer/settings/settings-state.test.ts`
- `apps/desktop/src/renderer/settings/device-settings.ts`
- `apps/desktop/src/renderer/settings/settings-panel.tsx`
- `apps/desktop/src/renderer/settings/settings-panel.test.ts`
- `apps/desktop/src/renderer/device/device-panel.tsx`
- `apps/desktop/src/renderer/device/device-panel.test.ts`
- `apps/desktop/src/main/plugins/builtin.ts`
- `apps/desktop/src/main/plugins/builtin.test.ts`
- `apps/desktop/packaging.ts`
- `apps/desktop/src/main/packaging.test.ts`

The two untracked renderer test files were read in full; ordinary git diff would omit them. Supporting unchanged renderer migration/freeze, monitor-effect and provider-eligibility seams were read only to resolve the requested checks. Own main/core implementation was excluded.

## Checks and conclusions

- **Per-window capture before plugin UI startup:** App obtains the window singleton before rendering interactive cutover controls. createPluginUiWindow constructs createDevicePreferencesMigration first, which synchronously freezes the three legacy keys before host construction/start and deferred challenge I/O. The window singleton avoids duplicate owners on React remount. Disposal rejects retained capture, removes catalog observation/listeners, and prevents post-disposal state publication or late submission. Retry retains the original snapshot and does not spin on identical device catalogs.
- **Completed-profile pending is neutral:** challenge rejection remains an observation state, not migration readiness. DevicePreferenceCaptureNotice explicitly says completed imports are not repeated; it does not claim pending import, failure, or require enabling the plugin. Capture success is not used to admit device I/O.
- **Legacy writers:** externalDevicePreferences is enabled for both pending and captured states. SettingsPanel filters device-backed preferences and all three legacy connection entries, disables the legacy preference hook, and leaves unrelated settings available. App guards both mode writes and address remembrance. The existing SettingsStore freeze also rejects direct writes and skips these keys during unrelated settings saves. Retained legacy handlers are no longer exposed by the redirected DevicePanel; pending-Run Cancel remains available.
- **Hidden legacy monitor demand:** App's MonitorWorkspace active expression requires rightPanel === ev3, settings closed, monitor tab, and no update preparation. The existing MonitorPanel effect depends on active and calls configure(sessionId, false) on cleanup/inactivity. Motor visibility is gated by that active value as well. Therefore showing public plugin tools does not leave the mounted hidden legacy monitor active. No legacy deletion was needed.
- **Single source/provider identity:** assembler install replaces the existing builtin device source in its original slot instead of appending a duplicate. Successful payload retains builtin:kobrixa.device-ev3 and the required provider metadata; the existing factory lookup and eligibility gate remain the single provider path. Assembly/manager creation does not launch the process. Disabled/safe-mode eligibility continues to prevent factory admission.
- **Payload failure:** resolution/validation failure replaces the same slot with a payloadUnavailable marker and empty resources; it does not retain the old builtin provider manifest, launch metadata, or provider claim. The new dev/packaged corruption tests exercise invalid loading. Packaging adds one delivered device process target; the actual-entry packaging test checks public SDK inclusion and absence of desktop-private source dependencies.

## Evidence and limits

Read the permanent renderer capture/retirement/neutral-notice tests, redirected DevicePanel test, settings-writer test, dev/packaged single-source/corruption tests, existing disabled/safe provider tests, and actual-entry packaging test. Controller reports **66 renderer PASS** and **47 assembly PASS / 1 existing skip**. These counts are controller evidence, not independently rerun results from this review. No test suite was repeated because source inspection raised no concrete concern requiring another run; no native/build/install operation was performed.

The visible-monitor condition and per-window App wiring were traced in source; this review did not mount the whole Electron App or exercise hardware suspend/renderer startup. Packaging test evidence does not establish installed native hardware behavior. E5 public-session adoption is a **required dependency**, not acceptance evidence supplied by this review. Full coordinated main/renderer/broker gating and E6 remain controller acceptance work.

Snapshot: /private/tmp/e5-cutover-review-snapshot.json. No additional product changes requested by this review.
