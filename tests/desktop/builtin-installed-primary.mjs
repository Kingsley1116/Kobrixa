import assert from "node:assert/strict";

export const motorId = "kobrixa.motor-test";

export function requiredCompilers(state) {
  for (const id of ["kobrixa.basic-plus", "kobrixa.ev3"]) {
    const plugin = state.plugins.find((item) => item.id === id);
    assert.ok(
      plugin?.required && plugin.status === "enabled",
      `Required compiler ${id}: ${JSON.stringify(plugin)}`,
    );
  }
}

export function assertSecondaryObservation(secondary) {
  const observed = secondary.observation;
  assert.equal(secondary.startup.pid, secondary.pid);
  assert.equal(secondary.startup.ready, false);
  assert.ok(secondary.observedIdentities.some((row) => row.pid === secondary.pid && row.created));
  assert.equal(observed.pid, secondary.pid);
  assert.equal(observed.beforeReady, true);
  assert.equal(observed.code, 0);
  assert.deepEqual(observed.locks, [{ acquired: false }]);
  for (const key of ["workers", "utilities", "children", "writes"])
    assert.deepEqual(
      observed[key],
      [],
      `Secondary ${key} must remain absent from entry through exit`,
    );
}

export function assertInstalledPrimary(report) {
  for (const key of [
    "originalPayloadIntact",
    "originalAppAsarIntact",
    "copiedAppAsarIntact",
    "originalExecutableIntact",
    "noPathNode",
    "noNodePath",
    "arbitraryCwd",
  ])
    assert.equal(report[key], true, key);
  for (const key of ["appAsarSha256", "originalExecutableSha256", "payloadIndexSha256"])
    assert.match(report.artifact[key], /^[a-f0-9]{64}$/);
  const run = report.runs[0],
    observation = run.singleInstance,
    secondary = observation.secondary;
  assert.equal(run.name, "single-instance");
  assert.equal(run.error, undefined);
  assert.equal(run.cleanupErrors, undefined);
  assert.equal(run.forcedCleanup, false);
  assert.equal(run.gracefulQuit, true);
  assert.equal(run.exit.code, 0);
  assert.equal(run.probeRestored, true);
  assert.deepEqual(run.remainingPids, []);
  assert.ok(run.fiveSecondCleanup.endedAt - run.fiveSecondCleanup.startedAt >= 5000);
  assert.deepEqual(run.fiveSecondCleanup.remainingPids, []);
  assert.equal(observation.listenersRemoved, true);
  assert.equal(observation.before.focused, true);
  assert.equal(observation.defocused.focused, false);
  assert.equal(observation.after.focused, true);
  assert.equal(observation.before.pid, run.pid);
  assert.equal(observation.after.pid, run.pid);
  assert.equal(observation.before.windowId, observation.after.windowId);
  assert.equal(observation.before.profile, run.profile);
  assert.equal(observation.after.profile, run.profile);
  assert.equal(secondary.requestedProfile, run.profile);
  assert.ok(Number.isSafeInteger(secondary.pid) && secondary.pid > 0 && secondary.pid !== run.pid);
  assert.ok(secondary.argv.includes(`--user-data-dir=${run.profile}`));
  assert.match(secondary.marker, /^--b2-secondary=[a-f0-9-]{36}$/);
  assert.ok(secondary.argv.includes(secondary.marker));
  assert.equal(secondary.error, undefined);
  assertSecondaryObservation(secondary);
  assert.match(secondary.logSha256, /^[a-f0-9]{64}$/);
  assert.equal(secondary.exit.code, 0);
  assert.equal(secondary.exit.signal, null);
  assert.equal(secondary.forcedCleanup, false);
  assert.equal(secondary.cleanupErrors, undefined);
  assert.deepEqual(secondary.remainingPids, []);
  assert.ok(secondary.cleanupObservedAt - secondary.exit.at >= 5000);
  const events = observation.events;
  const second = events.filter((event) => event.kind === "second-instance");
  assert.equal(second.length, 1);
  assert.ok(second[0].argv.includes(secondary.marker));
  assert.ok(second[0].argv.includes(`--user-data-dir=${run.profile}`));
  assert.equal(second[0].cwd, run.identity.cwd);
  assert.ok(second[0].at >= observation.defocused.at);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "focus" &&
        event.windowId === observation.before.windowId &&
        event.at >= observation.defocused.at,
    ),
  );
  assert.ok(observation.after.at >= second[0].at);
  assert.deepEqual(observation.before.forks, observation.after.forks);
  assert.ok(
    observation.before.forks.some(
      (fork) =>
        fork.serviceName === "Kobrixa plugin kobrixa.motor-test" && fork.pid > 0 && !fork.exited,
    ),
  );
  assert.deepEqual(observation.before.binding, observation.after.binding);
  assert.deepEqual(observation.before.workerStarts, observation.after.workerStarts);
  const workers = observation.before.workerStarts.filter(
    (row) =>
      typeof row.arguments?.[0] === "string" && row.arguments[0].includes("persistence-worker"),
  );
  assert.equal(workers.length, 1);
  assert.equal(
    run.workerTimeline.filter((row) => row.worker === workers[0].worker && row.event === "exit")
      .length,
    1,
  );
  assert.equal(run.identity.packaged, true);
  assert.equal(run.identity.userData, run.profile);
  assert.equal(run.probeBeforeReady, true);
  assert.ok(run.observedPids.includes(run.pid));
  assert.ok(secondary.observedPids.includes(secondary.pid));
  assert.ok(
    run.forks.some(
      (fork) =>
        fork.pid ===
          observation.before.forks.find(
            (f) => f.serviceName === "Kobrixa plugin kobrixa.motor-test",
          ).pid && fork.exited,
    ),
  );
  for (const state of [observation.before.state, observation.after.state]) {
    requiredCompilers(state);
    assert.equal(state.plugins.find((plugin) => plugin.id === motorId)?.running, true);
  }
  for (const phase of ["before", "after"]) {
    assert.equal(observation.hashes[phase].asar, report.artifact.appAsarSha256);
    assert.match(observation.hashes[phase].executable, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(observation.hashes.before, observation.hashes.after);
  for (const code of Object.values(run.isolation)) assert.ok(["EPERM", "EACCES"].includes(code));
  assert.ok(Object.keys(run.isolation).length >= 3);
}
