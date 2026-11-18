import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  matrix as brokerMatrix,
  matrixFromResults,
  assertMatrix,
} from "./device-broker-harness.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const types = [
  "group",
  "text",
  "help",
  "textInput",
  "number",
  "range",
  "choice",
  "boolean",
  "action",
  "holdAction",
  "status",
  "alert",
  "progress",
  "keyValue",
];

// Required T9 publication gate; observations must come from retained actual runs.
export const historicalUiChecks = {
  U01: (row) => {
    assert.deepEqual([...row.components].sort(), [...types].sort());
    assert.deepEqual(row.settingsControls, ["boolean", "number", "text", "choice"]);
    assert.equal(row.applyButton, false);
    assert.equal(row.invalidDraftPreserved, true);
  },
  U02: (row) => {
    for (const reason of [
      "version",
      "unknown-node",
      "extra-field",
      "translation",
      "cycle",
      "orphan",
      "duplicate",
      "reference",
      "path",
      "symlink",
      "condition",
      "prototype",
    ])
      assert.equal(row.rejections[reason].rejectedBeforeDispatch, true, reason);
    assert.equal(row.htmlLiteral, true);
    assert.equal(row.codeDetailPairsChecked, true);
  },
  U03: (row) => {
    for (const name of [
      "nodes",
      "depth",
      "resourceBytes",
      "sourceBytes",
      "hostBytes",
      "codePoints",
      "utf8",
    ])
      assert.deepEqual(row.boundaries[name], {
        minusOne: true,
        exact: true,
        plusOneRejected: true,
      });
    assert.equal(row.repeatedPathCharged, true);
    assert.equal(row.unicodeDeterministic, true);
  },
  U04: (row) => {
    assert.ok(row.subscribeAt < row.firstCatalogAt);
    for (const key of [
      "stalePageDiscarded",
      "lateResourceDiscarded",
      "revocationImmediate",
      "resourceAndExecutionGenerationsDistinct",
      "adapterThrowQuarantined",
      "latePatchRejected",
    ])
      assert.equal(row[key], true, key);
  },
  U05: (row) => {
    for (const key of [
      "atomicPatch",
      "draftRetained",
      "focusRetained",
      "staleResourceDetail",
      "gapSnapshotBarrier",
      "terminalPreserved",
    ])
      assert.equal(row[key], true, key);
    assert.ok(row.peakPatchQueue <= 4 && row.peakPatchBytes <= 65536);
    assert.ok(row.overflowDurationMs >= 30_000);
    assert.equal(row.linearQueueGrowth, false);
  },
  U06: (row) => {
    assert.equal(row.savedSdkVersion, "1.4.0");
    assert.match(row.savedSdkCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(row.languages, ["js", "python"]);
    assert.deepEqual(row.initializeFields, [
      "apiVersion",
      "grantedPermissions",
      "locale",
      "pluginId",
    ]);
    assert.equal(row.legacyResult, null);
    assert.equal(row.newNotificationsToOldSdk, 0);
    assert.equal(row.newSdkLegacyUsesExecute, true);
    assert.equal(row.oldSdkUiFailure, "PLUGIN_E_HANDSHAKE");
  },
  U07: (row) => {
    for (const key of [
      "argsExact16KiBAccepted",
      "argsPlusOneRejected",
      "formRaceRejected",
      "managementBindingAbsent",
      "crossSourceRejected",
      "argumentContextNotPromoted",
      "duplicateInvokedOnce",
      "invocationIdNotAction",
      "actionClaimOnce",
      "exceptionSanitized",
      "cancelNoReplay",
      "timeoutNoReplay",
      "lostReplyNoReplay",
    ])
      assert.equal(row[key], true, key);
  },
  U08: (row) => {
    assert.ok(row.maxSubscriptions <= 32 && row.maxPending <= 16);
    assert.ok(row.maxTelemetryFrames <= 64 && row.maxTelemetryBytes <= 65536);
    assert.ok(row.maxTelemetryQueueBytes <= 262144 && row.maxControlSlots <= 8);
    for (const key of [
      "validationBeforeEnqueue",
      "enqueueBeforeAck",
      "callbackDoesNotBlockControl",
      "futureAckRejected",
      "gapSnapshotBarrier",
      "foreignUnsubscribeRejected",
      "noRetirementLeak",
      "noSettingsUnwatchAlias",
    ])
      assert.equal(row[key], true, key);
    assert.deepEqual(row.unsubscribeResults, [true, false]);
  },
  U09: (row) => {
    assert.equal(row.cadenceMs, 100);
    assert.deepEqual(row.clock, { at349Live: true, at350Revoked: true, at351Revoked: true });
    for (const key of [
      "oldChallengeRejected",
      "oldInputTokenRejected",
      "oldGestureRejected",
      "pointerCancel",
      "keyUp",
      "lostCapture",
      "repeatSuppressed",
      "multiPointerSuppressed",
      "coastEscalatedToBrake",
      "staleReceiptDoesNotRenew",
    ])
      assert.equal(row[key], true, key);
  },
  U10: (row) => {
    assert.equal(row.broker, "actual-3A");
    assert.equal(row.provider, "formal-3A-fake-provider");
    assert.deepEqual(row.boundaries, ["prepare", "start", "arm", "pulse"]);
    assert.equal(row.composition, "createDesktopFoundation");
    assert.equal(row.mockIntent, false);
    assert.equal(row.cases.length, 48);
    const keys = new Set(
      row.cases.map((item) => `${item.boundary}/${item.position}/${item.fault}`),
    );
    for (const boundary of row.boundaries)
      for (const position of ["before", "after"])
        for (const fault of [
          "hide",
          "authority-loss",
          "cancel",
          "renderer-freeze",
          "renderer-crash",
          "plugin-kill",
        ])
          assert.ok(keys.has(`${boundary}/${position}/${fault}`));
    for (const item of row.cases) {
      assert.ok(item.observations.some((event) => event.kind === "revoke"));
      assert.ok(Array.isArray(item.trace));
      assert.equal(item.oldStartCountAfterRevoke, 0);
      assert.ok(item.wireProof.length > 0);
    }
    assert.equal(row.lostStartReplyReplayed, false);
    assert.equal(row.lateAckRenewed, false);
    assert.equal(row.stopReadbackUnderPressure, true);
    for (const event of [
      "hide",
      "authority-loss",
      "cancel",
      "renderer-freeze",
      "renderer-crash",
      "plugin-kill",
    ])
      assert.equal(row.races[event].oldStartCountAfterRevoke, 0, event);
    assert.equal(row.coreFaultRetained, true);
  },
  U11: (row) => {
    for (const key of [
      "requiredRefused",
      "toggleWithoutDeveloperMode",
      "togglePersisted",
      "optionalOnlyCrashUnlocked",
      "thirdPartyUncleanLocked",
      "unresponsiveLocked",
      "markerFailureBlocksThirdParty",
      "corruptMarkerHandled",
      "userDisableSurvivesRestore",
      "recoveryVisibleWithAllOptionalDisabled",
    ])
      assert.equal(row[key], true, key);
    assert.equal(row.coldSafeModeOptionalSpawns, 0);
    assert.equal(row.coldSafeModeOptionalRegistrations, 0);
  },
  U13: (row) => {
    assert.equal(row.windowMs, 300000);
    assert.equal(row.failureLimit, 3);
    assert.equal(row.launchFailuresCounted, true);
    assert.equal(row.handshakeFailuresCounted, true);
    assert.equal(row.normalShutdownCounted, false);
    assert.equal(row.explicitReset, true);
    assert.equal(row.automaticRestarts, 0);
    assert.equal(row.replayedCommands, 0);
    assert.equal(row.lateSpawnForceKilled, true);
    assert.deepEqual(row.remainingPids, []);
  },
  U14: (row) => {
    for (const key of [
      "hashes",
      "asarUnpack",
      "arbitraryCwd",
      "offline",
      "noPathNode",
      "noCheckout",
      "noWorkspaceNodeModules",
      "missingRejected",
      "corruptRejected",
    ])
      assert.equal(row[key], true, key);
    assert.equal(row.fixtureOnly, true);
    assert.deepEqual(row.remainingPids, []);
    assert.equal(row.productEntries, "pending-3C-3D-3E");
  },
  U15: (row) => {
    assert.deepEqual(row.locales, ["en", "zh-TW"]);
    assert.deepEqual(row.themes, ["light", "dark"]);
    assert.equal(row.widthPx, 320);
    assert.equal(row.scalePercent, 125);
    for (const key of [
      "keyboard",
      "focus",
      "conditions",
      "coreRecoveryIndependent",
      "siblingTabsExclusive",
      "remountNoDuplicateSubscription",
      "remountNoDuplicateGesture",
    ])
      assert.equal(row[key], true, key);
    assert.equal(row.motorProductRelocation, "pending-3C");
  },
  U16: (row) => {
    for (const key of [
      "forgedSender",
      "expired",
      "consumed",
      "oldWorkbench",
      "oldHostEpoch",
      "wrongItem",
      "wrongSession",
      "wrongRecord",
      "actionRefSubstitution",
      "invocationIdSubstitution",
    ])
      assert.equal(row.rejected[key], true, key);
    assert.equal(row.pluginCannotStopForeignOwner, true);
    assert.equal(row.resourceFreeDisconnectOrdered, true);
    assert.equal(row.actualSaveDisconnect, "pending-X-T1");
  },
  U17: (row) => {
    assert.equal(row.secondaryWriters, 0);
    assert.equal(row.secondaryProviders, 0);
    assert.equal(row.secondaryPlugins, 0);
    assert.equal(row.primaryFocused, true);
    assert.equal(row.suspendReason, "suspended");
    assert.equal(row.healthyGenerationRetained, true);
    assert.equal(row.wakeReplays, 0);
    assert.equal(row.oldTokenRejected, true);
    assert.equal(row.providerLossKeepsConsumer, true);
    assert.equal(row.rendererLossRetiresConsumer, true);
    assert.equal(row.fileExchangeMs, 10000);
    assert.equal(row.ordinaryExchangeMs, 5000);
    assert.equal(row.cleanupMs, 24000);
    assert.equal(row.outerSafetyNetMs, 25000);
    assert.equal(row.actualCheckpointRecovery, "pending-X-T1");
  },
};

export async function verifyHistoricalUiMatrix(matrix) {
  for (const [id, verify] of Object.entries(historicalUiChecks)) {
    const row = matrix[id];
    assert.ok(row, id);
    assert.equal(row.level, "actual", `${id}: mock/port fixture cannot close a real gate`);
    assert.ok(row.proof.length > 0, `${id}: raw evidence references required`);
    for (const proof of row.proof) assert.ok((await readFile(proof)).length > 0, `${id}: ${proof}`);
    verify(row);
  }
  assert.equal(matrix.U12.status, "pending-real-persistence");
  assert.equal(matrix.U12.closer, "X-T1");
  assert.equal(
    matrix.U12.producer,
    "tests/desktop/plugin-persistence-main.ts#createFoundationFixture",
  );
  assert.equal(matrix.U12.portFixturePassed, true);
  assert.equal(matrix.U12.realPassed, false);
  return { scope: "historical-P160", realPersistence: false };
}

// This is an index/oracle, never a second createFoundationFixture or native producer.
export const deadlines = Object.freeze({
  gestureCadenceMs: 100,
  gestureExpiryMs: 350,
  drainMs: 10000,
  stopMs: 15000,
  journalMs: 5000,
  managerMs: 4000,
  shutdownRequestMs: 2000,
  cleanupMs: 24000,
  outerSafetyNetMs: 25000,
  stagingIdleMs: 30000,
  stagingTotalMs: 120000,
  motorExchangeMs: 2000,
  ordinaryExchangeMs: 5000,
  fileExchangeMs: 10000,
});
export const grantRule =
  "Retain the original full owner, session, reservation, last sequence, drain token and expiry; pass retire().drain unchanged to freeze's fourth argument in the same turn. Repeated end, late registration, retry and retirement never renew the first deadline or TTL and never dispatch a second final handler.";
export const persistenceCases = Object.freeze([
  "retirement",
  "healthy-release",
  "registration-end",
  "contention",
  "suspend-wake",
  "disconnect-retry",
  "sealed-ttl",
  "unknown-publication",
  "action-replay",
  "renderer-loss",
  "all-optional-off",
]);
const coordinator = "apps/desktop/src/main/device-broker/lifecycle-coordinator.test.ts";
const authority = "apps/desktop/src/main/device-broker/authority-context.test.ts";
const control = "apps/desktop/src/renderer/collab/device-control.test.ts";
const mainControl = "apps/desktop/src/main/collab/device-control.test.ts";
const named = (file, name) => ({ file, name, status: "not-executed" });
const lifecycleRow = (id, motor, lab, cases, tests, gapOwner, gap) => ({
  id,
  motor,
  lab,
  persistenceCases: cases,
  tests,
  grantRule,
  deadlines,
  blocker:
    "Unconfirmed stop, journal failure or unsaved accepted work remains visible in core; one successful side never clears another blocker. Forced exit promises only committed recovery, never physical stop.",
  gap: { owner: gapOwner, reason: gap },
  status: "not-observed",
});
export const lifecycle = Object.freeze([
  lifecycleRow(
    "panel-hide",
    "Revoke gesture/start/renewal and request stop for hold, timed and angle motion on tab/pane/CSS hide.",
    "Continue background recording/checkpoints; remove preview demand; core retains status and Stop.",
    [],
    [named("tests/desktop/motor-test-public.test.mjs", "native matrix")],
    "W18a",
    "Actual motor/Lab hide and pending-start races with original provider trace.",
  ),
  lifecycleRow(
    "panel-close",
    "Stop before destroying the instance; reject late start/patch and retain uncertainty.",
    "Remove panel subscription; keep background reservation/status and healthy generation.",
    ["healthy-release"],
    [named(coordinator, "U12 reservation recovery updates settled evidence without redispatch")],
    "W18a",
    "Actual close/reopen bindings and ongoing recording, not healthy-release substituted for close.",
  ),
  lifecycleRow(
    "window-loss",
    "Blur/hide/minimize/document-hidden stop; destruction revokes all window authority.",
    "Blur/hide/minimize continue; destruction/last window close drains, saves and retires owner before process teardown.",
    ["renderer-loss"],
    [
      named(
        coordinator,
        "F17/F19 U12 uses one host fence and waits for actual original supervisor exit",
      ),
    ],
    "W18a/W18b",
    "Distinguish blur/minimize from destroyed window and normal close using shipped processes.",
  ),
  lifecycleRow(
    "os-suspend",
    "Revoke intent and stop/readback; core retains uncertainty; wake never resumes motion.",
    "End reservation, bounded drain/save; interrupted committed checkpoint/retry on failure; healthy process/generation may survive with gated session; wake never resumes recording.",
    ["suspend-wake", "sealed-ttl"],
    [
      named(
        coordinator,
        "F19 suspend keeps generation/process alive, and wake does not replay work",
      ),
    ],
    "W18a/W18b + H3",
    "Real feature suspend/failure/wake; actual OS/device sleep remains hardware/manual.",
  ),
  lifecycleRow(
    "second-instance-launch",
    "Secondary exits after primary focus; no operation, provider, plugin or journal construction and no replay.",
    "Primary recording continues unchanged; secondary creates no recorder, worker or profile writes.",
    [],
    [
      named(
        "tests/desktop/plugin-persistence-installed.test.mjs",
        "Observed subset remains partial with all four unrun gates",
      ),
    ],
    "W17/W19",
    "Observe secondary before initialization, creation identity/process tree and uninterrupted primary recording.",
  ),
  lifecycleRow(
    "feature-disable",
    "Deny admission, stop, withdraw UI/commands, bounded shutdown; faults stay in core.",
    "Deny new work, drain/stop/final commit before exit; save failure/checkpoint remains visible.",
    ["retirement", "registration-end", "sealed-ttl"],
    [
      named(
        coordinator,
        "A-RF5/F19 installs one listener, fences synchronously, and merges same-turn retire/freeze",
      ),
    ],
    "W18a/W18b",
    "Independent persisted toggles and pending command/motion/read/settings/checkpoint versus disable.",
  ),
  lifecycleRow(
    "provider-disable",
    "Gate work, stop/readback before provider/session revocation; quarantine uncertainty.",
    "End source and save, retain healthy consumer generation, show unavailable; provider replacement never resumes recording.",
    ["healthy-release", "registration-end"],
    [
      named(
        coordinator,
        "F19 suspend keeps generation/process alive, and wake does not replay work",
      ),
    ],
    "W18a",
    "Actual provider loss/disable/replacement, distinct from consumer disable; no idle provider autostart.",
  ),
  lifecycleRow(
    "renderer-crash",
    "Main revokes gestures/window authority and stops without renderer cleanup, including unresponsive/frozen renderer.",
    "End reservation; healthy feature drains then retires; unreachable owner recovers committed checkpoint as interrupted. Explicit open alone creates fresh generation/processEpoch and bindings.",
    ["renderer-loss"],
    [named(coordinator, "U12 clear waits for the actual supervisor shutdown receipt")],
    "W18a",
    "Actual freeze/crash and explicit reopen of motor/Lab/device; no reload autostart or stale revival.",
  ),
  lifecycleRow(
    "plugin-crash",
    "Main stops and revokes leases; late callbacks discarded, no replay; device UI crash is not provider shutdown.",
    "Host reclaims crashed owner's reservation/subscriptions; only committed checkpoint is promised; restart interrupted without resuming.",
    ["retirement", "unknown-publication"],
    [
      named(
        coordinator,
        "F17 crashed original peer reconciles without a drain callback or a second fence",
      ),
    ],
    "W18a/W18b",
    "Actual consumer death and worker publication death, original commit identity, no blind republish.",
  ),
  lifecycleRow(
    "app-shutdown",
    "Gate admission, stop/readback/journal before provider teardown. Normal close/update retains blockers; force exit records uncertainty.",
    "Normal close/update awaits bounded drain/final CAS/commit/flush; save failures offer retry. Forced exit recovers only committed data.",
    ["retirement", "registration-end", "disconnect-retry", "sealed-ttl", "unknown-publication"],
    [
      named(
        coordinator,
        "F17 unconfirmed stop, failed journal and unavailable legacy storage never become clean",
      ),
      named(
        coordinator,
        "F17 all owners share t0; timeout does not kill, renew storage or release the profile",
      ),
    ],
    "W18b",
    "Actual close and update coordinator, stuck drain, disk-full/sync failure, force exit/restart at original budgets.",
  ),
  lifecycleRow(
    "safe-mode",
    "Before restoring panels/documents suppress optional/third-party catalog, provider, process and connection; keep required compilers and core stop/recovery.",
    "No recorder/subscription autostart; keep records/checkpoint and core recovery/export. All-off remains usable; leaving safe mode preserves user disables.",
    ["all-optional-off", "action-replay"],
    [
      named(
        coordinator,
        "F17 empty participant requires positive resource-free proof and never fakes a recording save",
      ),
    ],
    "W18a/W19",
    "Optional-only unclean exit stays unlocked; third-party risk/unresponsive renderer locks. Actual cold all-off product recovery without enabling provider.",
  ),
]);
export const authorityRows = Object.freeze([
  {
    id: "request-grant-release",
    tests: [named(control, "lets an editor request, receive and release control")],
    expectation:
      "Only the current synced eligible holder can mutate; release fences old authority.",
    gap: "W18: join real public motor/Lab awaits to a two-client control transfer.",
  },
  {
    id: "decline",
    tests: [named(control, "lets the host decline a request and tells the requester")],
    expectation: "Decline grants no device authority.",
    gap: "W18: integrated denied public operation after decline.",
  },
  {
    id: "reclaim-reconnect-demotion",
    tests: [
      named(
        authority,
        "rotates epochs for reconnect, demotion, reclaim, release and explicit leave",
      ),
    ],
    expectation: "Every transition invalidates the old epoch even if authority returns.",
    gap: "W18: consequential shipped-feature awaits; H3 physical transfer.",
  },
  {
    id: "unsynced-offline-viewer",
    tests: [
      named(control, "denies control during reconnect and after the room closes"),
      named(control, "never grants control to a viewer, unknown member or offline editor"),
    ],
    expectation:
      "Absent/unbound, offline, unsynced, viewer and non-holder cannot mutate; no guest remote USB.",
    gap: "W18: real transport denial, not disabled buttons; H3 guest hardware.",
  },
  {
    id: "consequential-awaits",
    tests: [
      named(authority, "does not refresh the original epoch during a continuation"),
      named(authority, "rechecks after"),
    ],
    expectation:
      "Recheck original identity after drain/journal/preflight/upload/run/read/arm/pulse/poll/rename/file-close/batch/final-journal; stop lane remains independent.",
    gap: "W18: actual provider operations across each await; labelled test doubles alone do not prove all paths.",
  },
  {
    id: "read-stop-download",
    tests: [
      named(
        mainControl,
        "F03 denies missing reports and F14 preserves reads and stop after revoke",
      ),
      named(mainControl, "F14 only admits a download plan remembered from the service"),
    ],
    expectation:
      "Preserve reads/stop and existing service-issued download only; never admit an invented/unremembered plan.",
    gap: "W18: public exception behavior while authority changes.",
  },
  {
    id: "trusted-disconnect",
    tests: [
      named(
        coordinator,
        "A-RF5 Disconnect waits for a previously ended pending registration and the stop journal",
      ),
      named(
        coordinator,
        "Disconnect includes earlier-session finals for the same execution, without joining unrelated owners",
      ),
    ],
    expectation:
      "Public cross-owner Disconnect is busy; trusted user Disconnect waits for original stop/readback, journal and all real saves including prior-session finals.",
    persistenceCases: ["disconnect-retry", "contention"],
    gap: "W18: whole-product trusted action and cross-owner negative.",
  },
]);
export function inventory() {
  return {
    kind: "stage-3-lifecycle-index",
    format: 1,
    fullPass: false,
    scope: "W13a inventory; W13b final join remains separate",
    lifecycle: structuredClone(lifecycle),
    authority: structuredClone(authorityRows),
    broker: Object.entries(brokerMatrix).map(([id, files]) => ({
      id,
      files,
      status: "not-observed",
      scope: "unit/contract; not native or physical proof",
    })),
    ui: Array.from({ length: 17 }, (_, i) => ({
      id: `U${String(i + 1).padStart(2, "0")}`,
      status: "not-observed",
      scope: "historical-P160",
      replacement:
        i === 11
          ? [...persistenceCases]
          : i === 15
            ? ["disconnect-retry", "action-replay"]
            : i === 16
              ? ["suspend-wake", "all-optional-off"]
              : [],
    })),
    persistence: persistenceCases.map((id) => ({
      id,
      status: "not-observed",
      scope: "real persistence, synthetic foundation consumer; not shipped-feature proof",
    })),
    historicalException:
      "P160 U12 stays pending-real-persistence/realPassed=false. U16 actualSaveDisconnect and U17 actualCheckpointRecovery stay pending-X-T1. Later real observations are separate replacements, never edits to historical rows.",
  };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function readBoundFile(reference, directory) {
  assert.ok(reference && typeof reference.path === "string", "receipt path required");
  assert.match(reference.sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(path.resolve(directory, reference.path));
  assert.equal(digest(bytes), reference.sha256, `changed evidence: ${reference.path}`);
  return bytes;
}
// Identity is explicit because a commit alone cannot describe a concurrently dirty tree.
export async function verifySourceIdentity(identity) {
  assert.match(identity.commit, /^[a-f0-9]{40}$/);
  assert.equal(identity.apiVersion, "1.8.0");
  assert.ok(Object.keys(identity.sourceHashes).length > 0, "source hashes required");
  for (const [file, hash] of Object.entries(identity.sourceHashes)) {
    assert.ok(
      !path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."),
      "source must be repository-relative",
    );
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(digest(await readFile(path.join(root, file))), hash, `stale source: ${file}`);
  }
}

// Matches the existing producer's scoped-case artifact recipe, not a hash of
// only its main bundle. Each separate case may have its own build, never a
// relabelled installed application or a single package inferred from these hashes.
export async function verifyFoundationArtifact(raw, directory = root) {
  const entry = path.resolve(directory, raw.artifact);
  const buildRoot = path.dirname(entry);
  const main = await readFile(entry);
  assert.equal(digest(main), raw.bundleSha256, "changed foundation bundle");
  const { readFoundationRenderer } = await import("./plugin-persistence-renderer-build.mjs");
  const renderer = await readFoundationRenderer(
    path.join(raw.renderer.root, "renderer-artifact.json"),
  );
  assert.deepEqual(renderer, raw.renderer, "changed renderer identity");
  assert.ok(Object.keys(renderer.sourceSha256).length > 0, "renderer source hashes required");
  for (const [file, hash] of Object.entries(renderer.sourceSha256)) {
    assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes(".."));
    assert.equal(
      digest(await readFile(path.join(root, file))),
      hash,
      `stale renderer source: ${file}`,
    );
  }
  const chunks = [
    main,
    await readFile(path.join(buildRoot, "worker.cjs")),
    Buffer.from(renderer.receiptSha256),
    Buffer.from("null"),
  ];
  for (const role of ["recording", "settings"]) {
    const leaf = path.join(buildRoot, `plugins/acceptance-builtin-${role}`);
    const bytes = await readFile(path.join(leaf, "resource-index.json"));
    const index = JSON.parse(bytes);
    assert.equal(index.version, 1);
    assert.ok(index.files.length >= 2 && index.files.length <= 32);
    const names = index.files.map((file) => file.path);
    assert.deepEqual(names, [...new Set(names)].sort());
    assert.ok(names.includes("main.cjs") && names.includes("kobrixa-plugin.json"));
    for (const file of index.files) {
      assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes(".."));
      const contents = await readFile(path.join(leaf, file.path));
      assert.equal(contents.length, file.bytes, `changed leaf size: ${file.path}`);
      assert.equal(digest(contents), file.sha256, `changed leaf: ${file.path}`);
    }
    chunks.push(bytes);
  }
  assert.equal(digest(Buffer.concat(chunks)), raw.artifactSha256, "changed foundation artifact");
}

// The existing B2 sources use TS parameter properties. Keep the documented
// plain `node --test` entry usable by running ONLY their oracle in a Node child
// with the same transform/loader flags as test:persistence:oracles. No Electron,
// browser, localhost, or fixture composition is started. Original JSON travels
// over stdin (never a shell/argv-size-dependent serialization).
export async function verifyPersistenceReports(reports, commit) {
  const code = `import {verifyRunReceipt} from "./tests/desktop/plugin-persistence-harness.mjs";
let bytes=""; for await(const chunk of process.stdin) bytes+=chunk;
const {reports,commit}=JSON.parse(bytes);
for(const report of reports) verifyRunReceipt(report,{commit});`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        "./tests/desktop/persistence-source-loader.mjs",
        "--input-type=module",
        "-e",
        code,
      ],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RF5_SOURCE_ROOT: root, RF5_DEPS_ROOT: root },
      },
    );
    let diagnostics = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 180000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-32000);
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`B2 oracle failed (${code}/${signal}): ${diagnostics}`));
    });
    child.stdin.end(JSON.stringify({ reports, commit }));
  });
}

// JSON input: {format:1, identity:{commit,apiVersion,sourceHashes}, broker?:BoundFile,
// persistence?:BoundFile[]}. Every BoundFile is {path,sha256}; paths are relative to
// the input JSON. B2 files are unchanged --references / --case outputs. Historical
// UI input remains KOBRIXA_UI_MATRIX and is deliberately excluded from current identity.
// No receipt or supplied "passed" boolean can promote this inventory to whole-product acceptance.
export async function validateLifecycleEvidence(input, { directory = root, uiMatrix } = {}) {
  assert.equal(input.format, 1);
  await verifySourceIdentity(input.identity);
  const index = inventory();
  if (input.broker) {
    for (const file of new Set(Object.values(brokerMatrix).flat()))
      assert.ok(
        Object.hasOwn(input.identity.sourceHashes, file),
        `missing source identity: ${file}`,
      );
    const raw = JSON.parse(await readBoundFile(input.broker, directory));
    const result = matrixFromResults(raw);
    assertMatrix(result);
    index.broker = index.broker.map((row) => ({
      ...row,
      status: "observed-unit",
      assertions: result.cases.find((c) => c.id === row.id).assertions,
      receipt: input.broker,
    }));
  }
  if (uiMatrix) {
    await verifyHistoricalUiMatrix(uiMatrix);
    index.ui = index.ui.map((row) => ({
      ...row,
      status: row.id === "U12" ? "pending-real-persistence" : "observed-historical",
    }));
  }
  const reports = [];
  for (const reference of input.persistence ?? []) {
    const raw = JSON.parse(await readBoundFile(reference, directory));
    assert.equal(raw.format, 1);
    assert.equal(raw.level, "real-process");
    assert.ok(
      ["reference-only", "scoped-case"].includes(raw.status),
      "only explicit foundation receipts, not full-pass labels",
    );
    assert.ok(raw.reports.length > 0, "empty foundation receipt");
    assert.deepEqual([...raw.cases].sort(), raw.reports.map((r) => r.case).sort());
    for (const r of raw.reports) {
      assert.ok(persistenceCases.includes(r.case), `unmapped foundation case: ${r.case}`);
      assert.equal(r.commit, input.identity.commit, "cross-version foundation receipt");
      assert.equal(r.bundleSha256, raw.bundleSha256, "bundle mismatch");
      assert.equal(r.artifactSha256, raw.artifactSha256, "artifact mismatch");
    }
    await verifyFoundationArtifact(raw, directory);
    await verifyPersistenceReports(raw.reports, input.identity.commit);
    for (const r of raw.reports) {
      assert.ok(!reports.some((prior) => prior.case === r.case), `duplicate case: ${r.case}`);
      reports.push(r);
      const row = index.persistence.find((row) => row.id === r.case);
      Object.assign(row, {
        status: "observed-foundation",
        receipt: reference,
        runId: r.runId,
        hostEpoch: r.hostEpoch,
        bundleSha256: r.bundleSha256,
        artifactSha256: r.artifactSha256,
      });
    }
  }
  if (reports.length) {
    for (const file of [
      "tests/desktop/plugin-persistence-main.ts",
      "tests/desktop/plugin-persistence-run.mjs",
      "tests/desktop/plugin-persistence-harness.mjs",
    ])
      assert.ok(
        Object.hasOwn(input.identity.sourceHashes, file),
        `missing producer/oracle identity: ${file}`,
      );
    for (const key of ["profileId", "hostEpoch", "pid", "runId"])
      assert.equal(new Set(reports.map((r) => r[key])).size, reports.length, `reused ${key}`);
  }
  for (const row of [...index.lifecycle, ...index.authority]) {
    row.observations = (row.persistenceCases ?? []).map((id) =>
      index.persistence.find((r) => r.id === id),
    );
    // A foundation observation is deliberately not a pass for either shipped feature.
    row.status = row.observations.some((r) => r.status === "observed-foundation")
      ? "partial-foundation"
      : "not-observed";
  }
  return index;
}
export function requireCurrentFoundation(index) {
  assert.deepEqual(
    index.persistence.map((row) => row.id),
    [...persistenceCases],
    "missing/duplicate persistence rows",
  );
  assert.deepEqual(
    index.broker.map((row) => row.id),
    Object.keys(brokerMatrix),
    "missing/duplicate broker rows",
  );
  assert.deepEqual(
    index.ui.map((row) => row.id),
    Array.from({ length: 17 }, (_, i) => `U${String(i + 1).padStart(2, "0")}`),
    "missing/duplicate UI rows",
  );
  for (const row of index.persistence)
    assert.equal(row.status, "observed-foundation", `missing current foundation: ${row.id}`);
  for (const row of index.broker)
    assert.equal(row.status, "observed-unit", `missing broker observation: ${row.id}`);
  for (const row of index.ui)
    assert.ok(
      ["observed-historical", "pending-real-persistence"].includes(row.status),
      `missing historical UI: ${row.id}`,
    );
  assert.equal(index.fullPass, false, "foundation join never establishes whole-product acceptance");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--inventory")
    console.log(JSON.stringify(inventory(), null, 2));
  else {
    assert.ok(
      args.length === 1,
      "usage: node stage-3-lifecycle-matrix.mjs --inventory | <evidence.json>",
    );
    const file = path.resolve(args[0]);
    const uiMatrix = process.env.KOBRIXA_UI_MATRIX
      ? JSON.parse(await readFile(process.env.KOBRIXA_UI_MATRIX, "utf8"))
      : undefined;
    const result = await validateLifecycleEvidence(JSON.parse(await readFile(file, "utf8")), {
      directory: path.dirname(file),
      uiMatrix,
    });
    requireCurrentFoundation(result);
    console.log(JSON.stringify(result, null, 2));
  }
}
