import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertSingleInstanceReceipt,
  SINGLE_INSTANCE_UNRUN,
} from "./builtin-process-installed.mjs";

// Synthetic fixtures only test the verifier. They are never installed evidence.
function fixture() {
  const hash = "a".repeat(64),
    profile = "/temporary/original-profile",
    marker = "--b2-secondary=00000000-0000-4000-8000-000000000001";
  const state = {
    plugins: [
      { id: "kobrixa.basic-plus", required: true, status: "enabled" },
      { id: "kobrixa.ev3", required: true, status: "enabled" },
      { id: "kobrixa.motor-test", running: true },
    ],
  };
  const forks = [{ serviceName: "Kobrixa plugin kobrixa.motor-test", pid: 103, exited: false }];
  const workerStarts = [
    { worker: 0, event: "construct", arguments: ["/product/persistence-worker.cjs"] },
  ];
  const before = {
    pid: 101,
    windowId: 1,
    profile,
    focused: true,
    at: 1,
    state,
    forks,
    workerStarts,
    binding: { processEpoch: "original" },
  };
  return {
    kind: "installed-single-instance-partial",
    status: "partial",
    syntheticHost: false,
    isolated: true,
    unrun: [...SINGLE_INSTANCE_UNRUN],
    originalPayloadIntact: true,
    originalAppAsarIntact: true,
    copiedAppAsarIntact: true,
    originalExecutableIntact: true,
    noPathNode: true,
    noNodePath: true,
    arbitraryCwd: true,
    artifact: { appAsarSha256: hash, originalExecutableSha256: hash, payloadIndexSha256: hash },
    runs: [
      {
        name: "single-instance",
        pid: 101,
        profile,
        identity: { cwd: "/unrelated", packaged: true, userData: profile },
        probeBeforeReady: true,
        observedPids: [101, 103],
        workerTimeline: [...workerStarts, { worker: 0, event: "exit", code: 0 }],
        forks: [{ ...forks[0], exited: true }],
        gracefulQuit: true,
        forcedCleanup: false,
        probeRestored: true,
        exit: { code: 0, signal: null },
        remainingPids: [],
        isolation: { source: "EACCES", dependency: "EACCES", network: "EPERM" },
        fiveSecondCleanup: { startedAt: 1000, endedAt: 6000, remainingPids: [] },
        singleInstance: {
          listenersRemoved: true,
          before: structuredClone(before),
          after: { ...structuredClone(before), at: 10 },
          defocused: { focused: false, at: 2 },
          events: [
            { kind: "focus", windowId: 1, at: 3 },
            {
              kind: "second-instance",
              argv: [`--user-data-dir=${profile}`, marker],
              cwd: "/unrelated",
              at: 4,
            },
          ],
          hashes: {
            before: { asar: hash, executable: hash },
            after: { asar: hash, executable: hash },
          },
          secondary: {
            startup: { pid: 102, ready: false },
            observedIdentities: [{ pid: 102, created: "original-secondary" }],
            observation: {
              phase: "exit",
              pid: 102,
              beforeReady: true,
              code: 0,
              workers: [],
              utilities: [],
              children: [],
              writes: [],
              locks: [{ acquired: false }],
            },
            requestedProfile: profile,
            pid: 102,
            marker,
            argv: [`--user-data-dir=${profile}`, marker],
            exit: { code: 0, signal: null, at: 100 },
            forcedCleanup: false,
            remainingPids: [],
            observedPids: [102],
            cleanupObservedAt: 5100,
            logSha256: hash,
          },
        },
      },
    ],
  };
}
test("Observed startup subset remains partial with recording continuity unrun", () =>
  assertSingleInstanceReceipt(fixture()));
const bad = {
  "unobserved startup": (r) => delete r.runs[0].singleInstance.secondary.startup,
  "late observation": (r) => (r.runs[0].singleInstance.secondary.observation.beforeReady = false),
  "missing birth identity": (r) => (r.runs[0].singleInstance.secondary.observedIdentities = []),
  "secondary acquired lock": (r) =>
    (r.runs[0].singleInstance.secondary.observation.locks[0].acquired = true),
  "secondary worker": (r) =>
    r.runs[0].singleInstance.secondary.observation.workers.push({ api: "Worker" }),
  "secondary provider/plugin": (r) =>
    r.runs[0].singleInstance.secondary.observation.utilities.push({ api: "fork" }),
  "secondary child": (r) =>
    r.runs[0].singleInstance.secondary.observation.children.push({ api: "spawn" }),
  "secondary profile write": (r) =>
    r.runs[0].singleInstance.secondary.observation.writes.push({ api: "writeFile" }),
  "full-pass promotion": (r) => (r.status = "passed"),
  "missing unrun coverage": (r) => r.unrun.pop(),
  nonisolated: (r) => (r.isolated = false),
  "archive changed": (r) => (r.copiedAppAsarIntact = false),
  "same process": (r) => (r.runs[0].singleInstance.secondary.pid = 101),
  "different profile": (r) => (r.runs[0].singleInstance.secondary.requestedProfile = "/other"),
  "missing profile argument": (r) => r.runs[0].singleInstance.secondary.argv.shift(),
  "foreign second-instance": (r) => r.runs[0].singleInstance.events[1].argv.pop(),
  "no second-instance": (r) => r.runs[0].singleInstance.events.pop(),
  "duplicate event": (r) =>
    r.runs[0].singleInstance.events.push(r.runs[0].singleInstance.events[1]),
  "already focused": (r) => (r.runs[0].singleInstance.defocused.focused = true),
  "no focus event": (r) => r.runs[0].singleInstance.events.shift(),
  "wrong window": (r) => (r.runs[0].singleInstance.after.windowId = 2),
  "primary restart": (r) => (r.runs[0].singleInstance.after.pid = 109),
  "plugin restart": (r) => (r.runs[0].singleInstance.after.forks[0].pid = 109),
  "binding replacement": (r) => (r.runs[0].singleInstance.after.binding.processEpoch = "new"),
  "worker restarted": (r) => r.runs[0].singleInstance.after.workerStarts.push({ worker: 2 }),
  "missing worker exit": (r) => r.runs[0].workerTimeline.pop(),
  "secondary failed": (r) => (r.runs[0].singleInstance.secondary.exit.code = 1),
  "secondary killed": (r) => (r.runs[0].singleInstance.secondary.forcedCleanup = true),
  "primary killed": (r) => (r.runs[0].forcedCleanup = true),
  "early secondary cleanup": (r) => (r.runs[0].singleInstance.secondary.cleanupObservedAt = 1000),
  "early primary cleanup": (r) => (r.runs[0].fiveSecondCleanup.endedAt = 2000),
  "secondary survivor": (r) => r.runs[0].singleInstance.secondary.remainingPids.push(108),
  "primary survivor": (r) => r.runs[0].fiveSecondCleanup.remainingPids.push(108),
  "listeners leak": (r) => (r.runs[0].singleInstance.listenersRemoved = false),
  "image drift": (r) => (r.runs[0].singleInstance.hashes.after.executable = "b".repeat(64)),
  "source readable": (r) => (r.runs[0].isolation.source = "READABLE"),
};
for (const [name, mutate] of Object.entries(bad))
  test(`Reject ${name}`, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => assertSingleInstanceReceipt(r));
  });
test(
  "Controller partial receipt retains original evidence",
  { skip: !process.env.KOBRIXA_SINGLE_INSTANCE_REPORT && "controller native execution required" },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_SINGLE_INSTANCE_REPORT, "utf8"));
    assertSingleInstanceReceipt(report);
    const { createHash } = await import("node:crypto");
    const secondary = report.runs[0].singleInstance.secondary;
    assert.equal(
      createHash("sha256")
        .update(await readFile(secondary.log))
        .digest("hex"),
      secondary.logSha256,
    );
  },
);
