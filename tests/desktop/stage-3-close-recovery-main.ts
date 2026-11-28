import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProfileWriterLock, DeviceDisposition } from "@kobrixa/plugin-runtime";
import { unavailableUi150 } from "@kobrixa/plugin-runtime";
import { LifecycleCoordinator } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { UpdateInstallation } from "../../apps/desktop/src/main/updates/installation.js";
import { openStoreRoot } from "../../apps/desktop/src/main/plugins/persistence/filesystem.js";
import { createPersistenceHost } from "../../apps/desktop/src/main/plugins/persistence/host-port.js";
import { settingsRequests } from "../../apps/desktop/src/main/plugins/persistence/settings-service.js";
import {
  startPersistenceWorker,
  persistenceWorkerCount,
  diagnosticsFor,
  type PersistenceFaultControl,
} from "../../apps/desktop/src/main/plugins/persistence/worker.js";
import type {
  PublicationTicket,
  PersistenceBackend,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";

// Acceptance-host integration, NOT a whole-product or physical-device receipt.
// The worker, disk store, persistence participant and close/update coordinators
// are production implementations. Device, UI, updater and plugin process ports
// are explicitly resource-free adapters; they cannot prove stop or process exit.
const now = () => performance.now();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clean: DeviceDisposition = { stopConfirmed: true, journalCommitted: true, faultIds: [] };
export type Scenario = {
  operation: "record" | "settings";
  transition: "disable" | "close" | "update";
  fault: "none" | "before-publish";
};
export type WorkerInput = { directory: string; workerEntry: string; profile: ProfileWriterLock };

async function launch(input: WorkerInput) {
  await mkdir(input.directory, { recursive: true });
  const root = await openStoreRoot({ userData: input.directory, profile: input.profile });
  let control: PersistenceFaultControl | undefined;
  const started = await startPersistenceWorker({
    profile: input.profile,
    root,
    workerEntry: input.workerEntry,
    now,
    testControl: (value) => {
      control = value;
    },
  });
  assert.equal(started.recovery, "ready");
  assert.ok(control);
  assert.equal(persistenceWorkerCount(started.backend), 1);
  return { ...started, control };
}
function makeTicket(owner: PublicationTicket["owner"], operation: Scenario["operation"]) {
  const bytes = Buffer.from(
    operation === "record"
      ? "W18b committed record bytes"
      : JSON.stringify({
          formatVersion: 1,
          schemaVersion: 1,
          validationDigest: "a".repeat(64),
          values: [{ key: "enabled", value: false }],
        }),
  );
  const id = randomUUID();
  const ticket: PublicationTicket = {
    id: randomUUID(),
    owner,
    deadlineMonotonicMs: now() + 10000,
    ...(operation === "record"
      ? {
          target: { kind: "record" as const, id, expectedRevision: null },
          metadata: {
            kind: "record" as const,
            deleted: false,
            record: {
              id,
              revision: "r_" + randomUUID().replaceAll("-", ""),
              kind: "w18b",
              schemaVersion: 1,
              label: "W18b",
              mediaType: "application/octet-stream",
              byteLength: bytes.length,
              sha256: hash(bytes),
              createdAt: 1,
              updatedAt: 1,
              checkpoint: "none" as const,
              interrupted: false,
            },
          },
        }
      : {
          target: { kind: "settings" as const, expectedRevision: null },
          metadata: {
            kind: "settings" as const,
            schemaVersion: 1,
            validationDigest: "a".repeat(64),
          },
        }),
  };
  return { ticket, bytes };
}
async function stage(backend: PersistenceBackend, ticket: PublicationTicket, bytes: Uint8Array) {
  await backend.engine.reserve(ticket, bytes.length);
  await backend.engine.append(ticket, 0, bytes);
  await backend.engine.seal(ticket, bytes.length, hash(bytes));
}
const unexpected = (): never => {
  throw new Error("Unexpected adapter operation");
};
const ownerFor = (profile: ProfileWriterLock) => ({
  sourceKey: "builtin:acceptance.close-recovery",
  pluginId: "acceptance.close-recovery",
  generation: 1,
  hostEpoch: profile.hostEpoch,
  processEpoch: randomUUID(),
});
async function makeHost(
  input: WorkerInput,
  backend: PersistenceBackend,
  owner: ReturnType<typeof ownerFor>,
) {
  const resolved = {
    owner: { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 },
    resource: {
      schemaVersion: 1,
      title: { en: "W18b" },
      fields: [
        { key: "enabled", type: "boolean" as const, label: { en: "Enabled" }, default: true },
      ],
    },
    validationDigest: "a".repeat(64),
  };
  const host = await createPersistenceHost({
    profile: input.profile,
    now,
    hasPermission: () => true,
    composition: {
      backend,
      sources: { current: () => true, settings: async () => resolved, coreOwner: () => owner },
      dispatchDrain: async () => ({ ok: true, value: { status: "checkpoint-only", writes: [] } }),
      events: {
        diagnostics: unexpected,
        create: unexpected,
        owns: unexpected,
        publish: unexpected,
        activate: unexpected,
        resync: unexpected,
        snapshot: unexpected,
        ack: unexpected,
        unsubscribe: unexpected,
        closeAfterControl: unexpected,
        onRemoved: () => () => {},
      },
      imports: {
        run: unexpected,
        acceptPreferences: unexpected,
        issuePreferences: unexpected,
        retirePreferences: unexpected,
        acceptPreferencesEvidence: unexpected,
      },
    },
    reservations: { validate: () => null, onEnded: unexpected },
    actions: { claim: unexpected },
    actionAdapter: { chooseDestination: async () => null, copyText: async () => {} },
    coreActions: { claim: () => false, isClaimed: () => false, complete: () => {} },
  });
  settingsRequests(backend).admit(owner, "b".repeat(64), resolved);
  return host;
}
async function readCommitted(backend: PersistenceBackend, ticket: PublicationTicket) {
  if (ticket.target.kind === "settings") return backend.reads.settings(ticket.owner);
  assert.equal(ticket.target.kind, "record");
  if (ticket.target.kind !== "record") throw new Error("record expected");
  const entries = await backend.reads.list(ticket.owner, { limit: 64 });
  const id = ticket.target.id;
  const meta = entries.entries.find((row) => row.id === id);
  if (!meta) return null;
  const pin = await backend.reads.open(ticket.owner, meta.id, meta.revision);
  try {
    return {
      meta,
      bytes: Buffer.from(await backend.reads.read(ticket.owner, pin, 0, 262144)).toString("base64"),
    };
  } finally {
    await backend.reads.close(ticket.owner, pin);
  }
}

export async function runPublication(input: WorkerInput, scenario: Scenario) {
  const env = await launch(input),
    owner = ownerFor(input.profile);
  let admitted: PublicationTicket | undefined;
  const reserve = env.backend.engine.reserve;
  let published: Awaited<ReturnType<typeof env.backend.engine.publish>> | undefined;
  let publicationError: string | null = null;
  const publish = env.backend.engine.publish;
  env.backend.engine.publish = async (ticket) => {
    try {
      const value = await publish(ticket);
      published = structuredClone(value);
      return value;
    } catch (error) {
      publicationError = String(error);
      throw error;
    }
  };
  env.backend.engine.reserve = (ticket, length) => {
    admitted = structuredClone(ticket);
    return reserve(ticket, length);
  };
  const host = await makeHost(input, env.backend, owner);
  const events: Array<{ event: string; at: number }> = [];
  const event = (name: string) => {
    events.push({ event: name, at: now() });
  };
  const errors: string[] = [];
  const cleanup = { workers: -1, workerJobs: -1 };
  let shutdowns = 0,
    installs = 0,
    preparing = false;
  const resources = {
    retire: () => ({ drain: null, settled: Promise.resolve(clean) }),
    retireProvider: async () => clean,
    beginShutdown: async () => clean,
  };
  const offers: Array<{ started: number; deadline: number }> = [];
  const freeze = host.participant.freeze.bind(host.participant);
  host.participant.freeze = (...args) => {
    const started = now(),
      offer = freeze(...args);
    offers.push({ started, deadline: offer.deadlineMonotonicMs });
    return offer;
  };
  const lifecycle = new LifecycleCoordinator({
    ports: { device: resources, persistence: host.participant, ui: unavailableUi150() },
    resources,
    persistence: host.participant,
    reservations: { validate: () => null, onEnded: () => () => {} },
    sessions: { quiesce: unexpected, disconnect: unexpected, resume: unexpected },
    alive: () => true,
    owners: () => [owner],
    now,
    dispatch: async () => ({ ok: true, value: { status: "checkpoint-only", writes: [] } }),
    shutdown: async () => {
      shutdowns++;
      event("shutdown-adapter");
    },
    legacyFlush: async () => {},
    report: (error) => errors.push(String(error)),
  });
  const update = new UpdateInstallation(
    {
      get preparing() {
        return preparing;
      },
      prepareInstall() {
        preparing = true;
        event("update-prepare");
      },
      cancelInstall() {
        preparing = false;
        event("update-cancel");
      },
      install() {
        installs++;
        event("install-adapter");
      },
    },
    () => lifecycle.close("update"),
    () => lifecycle.close("update"),
  );
  const { bytes } = makeTicket(owner, scenario.operation);
  const principal = { kind: "plugin" as const, owner, authorityContext: null };
  const signal = new AbortController().signal;
  const accepted = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    assert.ok(value.ok, JSON.stringify(value));
    if (!value.ok) throw new Error("Request failed");
    return value.value;
  };
  let result: Awaited<ReturnType<typeof env.backend.engine.publish>> | undefined;
  try {
    let write: string | undefined;
    if (scenario.operation === "record") {
      write = accepted(
        await host.request(
          principal,
          "storage/beginWrite",
          {
            target: { mode: "create" },
            kind: "w18b",
            schemaVersion: 1,
            label: "W18b",
            mediaType: "application/octet-stream",
            byteLength: bytes.length,
            sha256: hash(bytes),
          },
          signal,
        ),
      ).write;
      accepted(
        await host.request(
          principal,
          "storage/writeChunk",
          { write, offset: 0, data: bytes.toString("base64") },
          signal,
        ),
      );
      accepted(await host.request(principal, "storage/sealWrite", { write }, signal));
    }
    // Pause before the real atomic publication, not in a fake persistence port.
    env.control.arm("before-publish", "pause");
    const reached = env.control.reached("before-publish");
    const publicRequest =
      scenario.operation === "record"
        ? host.request(principal, "storage/commitWrite", { write: write! }, signal)
        : host.request(
            principal,
            "settings/update",
            {
              schemaVersion: 1,
              expectedRevision: null,
              changes: [{ key: "enabled", value: false }],
            },
            signal,
          );
    await reached;
    assert.ok(admitted);
    const ticket = admitted;
    event("worker-paused");
    let settled = false;
    event("transition-start");
    const transition = (
      scenario.transition === "disable"
        ? lifecycle.retire(owner, "disable")
        : scenario.transition === "update"
          ? update.prepare()
          : lifecycle.close("close")
    )
      .then(
        () => ({ rejected: false, error: null }),
        (error: unknown) => ({ rejected: true, error: String(error) }),
      )
      .finally(() => {
        settled = true;
        event("transition-settled");
      });
    await pause(50);
    assert.equal(settled, false, "Pending worker publication must prevent completion");
    assert.equal(shutdowns, 0);
    assert.equal(installs, 0);
    event("pending-observed");
    if (scenario.fault === "before-publish") {
      // Kill the real worker before head replacement. This is worker loss,
      // not an ENOSPC simulation or a forced whole-application exit.
      await env.control.terminate();
      event("worker-terminated-before-publish");
    } else {
      env.control.release("before-publish");
      event("worker-released");
    }
    const reply = await publicRequest;
    assert.ok(published || publicationError, JSON.stringify(reply));
    result = published;
    event("publication-result");
    const outcome = await transition;
    const reports = lifecycle.reports();
    if (scenario.fault === "none") {
      assert.ok(result, JSON.stringify({ reply, publicationError }));
      assert.equal(result.disposition, "committed");
      assert.ok(result.receipt);
      assert.equal(outcome.rejected, false);
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.storage.state, "saved", JSON.stringify({ reports, result }));
      assert.equal(reports[0]!.storage.blocker, false);
      if (scenario.transition === "update") await update.install();
    } else {
      assert.notEqual(result?.disposition, "committed");
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.blocker, true);
      assert.equal(reports[0]!.storage.blocker, true);
      if (scenario.transition !== "disable") assert.equal(outcome.rejected, true);
      assert.equal(shutdowns, 0);
      assert.equal(installs, 0);
    }
    const readback = scenario.fault === "none" ? await readCommitted(env.backend, ticket) : null;
    return {
      scenario,
      owner,
      ticket,
      payload: bytes.toString("base64"),
      events,
      offers,
      publication: result ?? null,
      publicationError,
      reply,
      outcome,
      reports,
      readback,
      trace: env.control.trace(),
      shutdowns,
      installs,
      errors,
      cleanup,
    };
  } catch (error) {
    await writeFile(
      path.join(input.directory, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          scenario,
          admitted,
          published,
          publicationError,
          events,
          offers,
          trace: env.control.trace(),
          reports: lifecycle.reports(),
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    env.control.release("before-publish");
    lifecycle.dispose();
    if (scenario.fault === "none") await host.dispose();
    else await host.dispose().catch((error: unknown) => errors.push(String(error)));
    cleanup.workers = persistenceWorkerCount(env.backend);
    cleanup.workerJobs = diagnosticsFor(env.backend).snapshot().workerJobs;
    assert.equal(cleanup.workers, 0);
    assert.equal(cleanup.workerJobs, 0);
    event("worker-cleanup-observed");
  }
}

/** Kill an actual worker at a publication boundary, reopen the same disk profile. */
export async function runRecovery(input: WorkerInput, point: "before-publish" | "after-publish") {
  const first = await launch(input),
    owner = ownerFor(input.profile);
  const old = makeTicket(owner, "record"),
    nextBytes = Buffer.from("W18b new committed bytes");
  assert.equal(old.ticket.metadata.kind, "record");
  if (old.ticket.metadata.kind !== "record" || old.ticket.target.kind !== "record")
    throw new Error("record expected");
  const next: PublicationTicket = {
    ...old.ticket,
    id: randomUUID(),
    target: { ...old.ticket.target, expectedRevision: old.ticket.metadata.record.revision },
    metadata: {
      ...old.ticket.metadata,
      record: {
        ...old.ticket.metadata.record,
        revision: "r_" + randomUUID().replaceAll("-", ""),
        byteLength: nextBytes.length,
        sha256: hash(nextBytes),
      },
    },
  };
  let trace: ReturnType<PersistenceFaultControl["trace"]> = [];
  const cleanup = { terminatedWorkers: -1, reopenedWorkers: -1, workerJobs: -1 };
  let interruptedPublication:
    | {
        result: Awaited<ReturnType<PersistenceBackend["engine"]["publish"]>> | null;
        error: string | null;
      }
    | undefined;
  try {
    await stage(first.backend, old.ticket, old.bytes);
    const seed = await first.backend.engine.publish(old.ticket);
    assert.equal(seed.disposition, "committed");
    await stage(first.backend, next, nextBytes);
    first.control.arm(point, "pause");
    const reached = first.control.reached(point),
      pending = first.backend.engine.publish(next).then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error: String(error) }),
      );
    await reached;
    trace = first.control.trace();
    await first.control.terminate();
    interruptedPublication = await pending;
    assert.notEqual(interruptedPublication.result?.disposition, "committed");
    assert.ok(interruptedPublication.result || interruptedPublication.error);
    cleanup.terminatedWorkers = persistenceWorkerCount(first.backend);
    assert.equal(cleanup.terminatedWorkers, 0);
  } finally {
    await first.control.terminate();
    await first.backend.dispose().catch(() => {});
  }
  const reopened = await launch(input);
  try {
    const readback = await readCommitted(reopened.backend, old.ticket);
    const expected = point === "before-publish" ? old.bytes : nextBytes;
    assert.ok(readback && "bytes" in readback);
    assert.equal(readback.bytes, expected.toString("base64"));
    const expectedTicket = point === "before-publish" ? old.ticket : next;
    assert.equal(expectedTicket.metadata.kind, "record");
    if (expectedTicket.metadata.kind !== "record") throw new Error("record expected");
    assert.equal(readback.meta.revision, expectedTicket.metadata.record.revision);
    return {
      point,
      old: old.ticket,
      next,
      expected: expected.toString("base64"),
      readback,
      trace,
      interruptedPublication,
      restartTrace: reopened.control.trace(),
      recovery: reopened.recovery,
      cleanup,
    };
  } finally {
    await reopened.backend.dispose();
    cleanup.reopenedWorkers = persistenceWorkerCount(reopened.backend);
    cleanup.workerJobs = diagnosticsFor(reopened.backend).snapshot().workerJobs;
    assert.equal(cleanup.reopenedWorkers, 0);
    assert.equal(cleanup.workerJobs, 0);
  }
}
