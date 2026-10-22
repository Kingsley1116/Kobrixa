import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFixtures, materialize, maximumPanel, mutations } from "./declarative-ui-harness.mjs";

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

test(
  "U06/U07/U13: actual MessagePort and Python stdio receipts",
  {
    skip: process.env.KOBRIXA_UI_REPORT
      ? false
      : "controller must run Electron; helper-only run is not acceptance",
  },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_UI_REPORT, "utf8"));
    assert.equal(report.kind, "ui-transport");
    assert.equal(report.mockHost, true);
    assert.deepEqual(report.results.map((row) => row.language).sort(), ["js", "python"]);
    assert.deepEqual(report.remainingPids, []);
    for (const row of report.results) {
      assert.deepEqual(row.initializeKeys, [
        "apiVersion",
        "grantedPermissions",
        "locale",
        "pluginId",
      ]);
      assert.equal(row.apiVersion, "1.6.0");
      assert.equal(row.legacy, null);
      assert.deepEqual(row.negotiated, { commandEnvelopeVersions: [1], uiResourceVersions: [1] });
      assert.equal(row.duplicateCalls, 1);
      assert.equal(row.managementHasBinding, false);
      assert.equal(row.managementHasMotion, false);
      assert.equal(row.unicode, "🙂界");
      assert.equal(row.callbackError, "PLUGIN_E_COMMAND_FAILED");
      assert.equal(row.callbackStarted, true);
      assert.ok(row.logs.some((line) => line.includes(`UI_CALLBACK_WAIT:${row.cancellationId}`)));
      assert.equal(row.cancelled, true);
      assert.equal(row.afterCancellationCalls, 2);
      assert.equal(row.exited, true);
      assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
      assert.ok(row.wire.some((item) => item.message.method === "$/cancelRequest"));
    }
  },
);

test("U01/U15: fixture uses every v1 component and real number/choice/hold arguments", async () => {
  const { manifest, panel, status } = await readFixtures();
  assert.equal(manifest.apiVersion, "^1.6.0");
  assert.deepEqual([...new Set(panel.nodes.map((n) => n.type))].sort(), types.sort());
  assert.equal(panel.fields.speed.schema.type, "number");
  assert.equal(panel.fields.mode.schema.type, "enum");
  assert.deepEqual(panel.nodes.find((n) => n.type === "holdAction").arguments, {
    speed: { ref: { scope: "form", key: "speed" } },
    mode: { ref: { scope: "form", key: "mode" } },
  });
  assert.deepEqual(Object.keys(status).sort(), ["data", "kind", "text", "tone"]);
  assert.equal(panel.nodes.find((n) => n.id === "text").value.text.en, "<b>literal, not HTML</b>");
});

test("U02/U03: independent malformed fixtures cannot mutate the valid baseline", async () => {
  const { panel } = await readFixtures();
  const before = JSON.stringify(panel);
  const cases = mutations(panel);
  assert.deepEqual(
    cases.map((c) => c.id),
    [
      "unknown-node",
      "extra-field",
      "missing-en",
      "cycle",
      "orphan",
      "duplicate",
      "missing-reference",
      "condition",
      "prototype",
    ],
  );
  assert.equal(new Set(cases.map((c) => JSON.stringify(c.resource))).size, cases.length);
  assert.equal(JSON.stringify(panel), before);
  const maximum = maximumPanel(panel);
  assert.equal(maximum.nodes.length, 256);
  const byId = new Map(maximum.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  function walk(id, depth) {
    assert.ok(depth <= 8);
    assert.ok(!seen.has(id));
    seen.add(id);
    const node = byId.get(id);
    assert.ok(node);
    if (node.type === "group") {
      assert.ok(node.children.length >= 1 && node.children.length <= 32);
      return Math.max(depth, ...node.children.map((child) => walk(child, depth + 1)));
    }
    return depth;
  }
  assert.equal(walk(maximum.root, 1), 8);
  assert.equal(seen.size, 256);
});

test("U03: capacity fixture has 16 panels, 16 statuses, exactly 8 MiB UTF-8 resources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ui-capacity-test-"));
  try {
    const paths = await materialize(directory, { sources: 8, maximum: true });
    let panels = 0,
      statuses = 0,
      total = 0;
    for (const directory of paths) {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "kobrixa-plugin.json"), "utf8"),
      );
      panels += manifest.contributes.panels.length;
      statuses += manifest.contributes.status.length;
      let sourceBytes = 0;
      for (const item of [...manifest.contributes.panels, ...manifest.contributes.status]) {
        const raw = await readFile(path.join(directory, item.resource.path));
        assert.equal(raw.length, 256 * 1024);
        JSON.parse(raw.toString("utf8"));
        sourceBytes += raw.length;
      }
      assert.equal(sourceBytes, 1024 * 1024);
      total += sourceBytes;
    }
    assert.deepEqual(
      { panels, statuses, total },
      { panels: 16, statuses: 16, total: 8 * 1024 * 1024 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python browser fixture clones manifest and registered command identity together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ui-python-identity-"));
  try {
    const [leaf] = await materialize(directory, { language: "python" });
    const manifest = JSON.parse(await readFile(path.join(leaf, "kobrixa-plugin.json"), "utf8"));
    const consumer = await readFile(path.join(leaf, "consumer.py"), "utf8");
    assert.deepEqual(manifest.runtime, { kind: "python", entry: "consumer.py" });
    for (const command of manifest.contributes.commands)
      assert.ok(consumer.includes(`"${command.id}"`));
    assert.equal(consumer.includes('"acceptance.ui.activate"'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AM-19: actual shared validator rejects identical malformed resources and byte +1", async () => {
  const { validateUiResource } = await import("../../packages/plugin-protocol/dist/index.js");
  const { manifest, panel } = await readFixtures();
  const context = {
    pluginId: manifest.id,
    commands: manifest.contributes.commands,
    panels: manifest.contributes.panels,
  };
  const validate = (resource, bytes = Buffer.byteLength(JSON.stringify(resource), "utf8")) =>
    validateUiResource(resource, context, bytes);
  assert.equal(validate(panel).ok, true);
  assert.equal(validate(panel, 256 * 1024).ok, true);
  assert.equal(validate(panel, 256 * 1024 + 1).ok, false);
  for (const { id, resource } of mutations(panel)) assert.equal(validate(resource).ok, false, id);
  assert.equal(validate(maximumPanel(panel)).ok, true);
  const overNodes = maximumPanel(panel);
  overNodes.nodes.push({
    id: "one-too-many",
    type: "text",
    emphasis: "normal",
    value: { text: { en: "extra" } },
  });
  assert.equal(validate(overNodes).ok, false);
});

// Required T9 publication gate; observations must come from retained actual runs.
const matrixChecks = {
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
test(
  "U01-U17: P160 matrix closes only observed real gates",
  {
    skip: process.env.KOBRIXA_UI_MATRIX
      ? false
      : "matrix evidence absent; not publication acceptance",
  },
  async () => {
    const matrix = JSON.parse(await readFile(process.env.KOBRIXA_UI_MATRIX, "utf8"));
    for (const [id, verify] of Object.entries(matrixChecks)) {
      const row = matrix[id];
      assert.ok(row, id);
      assert.equal(row.level, "actual", `${id}: mock/port fixture cannot close a real gate`);
      assert.ok(row.proof.length > 0, `${id}: raw evidence references required`);
      for (const proof of row.proof)
        assert.ok((await readFile(proof)).length > 0, `${id}: ${proof}`);
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
  },
);
