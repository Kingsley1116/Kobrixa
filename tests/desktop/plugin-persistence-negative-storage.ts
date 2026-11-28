import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ResourceOwner, StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { PersistenceBackend } from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { RecordServicePort } from "../../apps/desktop/src/main/plugins/persistence/record-port.js";
import type { PersistenceFaultControl } from "../../apps/desktop/src/main/plugins/persistence/worker.js";

/** W10 handoff: pass its existing host.request, backend, authenticated owner and
 * fault control. Run each scenario in an isolated profile. snapshot must sample
 * actual core/handle registries; reopen must stop the original composition and
 * reopen the SAME profile with a fresh hostEpoch. No replacement service is
 * constructed here. The Node oracle uses the production record service/worker;
 * it explicitly reports missing core/transport evidence, never full acceptance.
 * Syscall injection is private harness plumbing, not a plugin API. W10 must
 * implement inject at the real worker filesystem boundary, not replace replies.
 */
export const storageNegativeScenarios = {
  N07: ["short-write", "zero-write", "ENOSPC", "EDQUOT", "EROFS", "EACCES"],
  N08: ["seal-sync", "object-rename"],
  N09: ["fence-before-publish"],
  N10: ["after-publish", "head-dir-sync"],
  N11: ["directory-EIO"],
  N12: ["cleanup-unlink", "pinned-replacement"],
  N13: ["paged-delete", "generation-read", "idle-read"],
  N14: ["corrupt-object", "unknown-version"],
  N15: ["incomplete-flush", "unknown-flush"],
  N29: ["symlink-object", "hardlink-object"],
} as const;
export type StorageNegativeRow = keyof typeof storageNegativeScenarios;
export type StorageNegativeScenario = (typeof storageNegativeScenarios)[StorageNegativeRow][number];
export const storageHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function storageTree(
  root: string,
): Promise<Record<string, { bytes: number; sha256: string }>> {
  const result: Record<string, { bytes: number; sha256: string }> = {};
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name),
        st = await lstat(file);
      if (st.isDirectory()) await visit(file);
      else if (st.isFile()) {
        const bytes = await readFile(file);
        result[path.relative(root, file)] = { bytes: bytes.length, sha256: storageHash(bytes) };
      }
      // Never follow a symlink introduced by N29.
    }
  }
  await visit(root);
  return result;
}
export type StorageNegativeInput = {
  owner: ResourceOwner;
  backend: PersistenceBackend;
  request: RecordServicePort["request"];
  fault: PersistenceFaultControl;
  root: string;
  snapshot(): Promise<{ core: unknown | null; handles: unknown | null }>;
  inject(scenario: StorageNegativeScenario, recordId: string): Promise<void>;
  clearInjection(): Promise<void>;
  reopen(): Promise<{
    owner: ResourceOwner;
    backend: PersistenceBackend;
    request: RecordServicePort["request"];
    snapshot(): Promise<{ core: unknown | null; handles: unknown | null }>;
    close(): Promise<void>;
  }>;
};
export type StorageNegativeObservation = {
  row: StorageNegativeRow;
  scenario: StorageNegativeScenario;
  scope: "host-worker-subproof";
  owner: ResourceOwner;
  calls: { method: string; params: unknown; result: unknown; start: number; end: number }[];
  snapshots: {
    phase: string;
    epoch: string;
    tree: Awaited<ReturnType<typeof storageTree>>;
    quota: unknown;
    durableRecovery: unknown;
    core: unknown | null;
    handles: unknown | null;
  }[];
  trace: ReturnType<PersistenceFaultControl["trace"]>;
  gaps: string[];
};
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Unreachable failed result");
  return result.value;
}
function denied(result: unknown, code: string, reason?: string) {
  const r = result as { ok: boolean; error: { code: string; detail?: { reason?: string } } };
  assert.equal(r.ok, false, JSON.stringify(result));
  assert.equal(r.error.code, code);
  if (reason) assert.equal(r.error.detail?.reason, reason);
}
export async function produceStorageNegative(
  input: StorageNegativeInput,
  row: StorageNegativeRow,
  scenario: StorageNegativeScenario,
): Promise<StorageNegativeObservation> {
  assert.ok((storageNegativeScenarios[row] as readonly string[]).includes(scenario));
  const principal = { kind: "plugin" as const, owner: input.owner, authorityContext: null };
  const signal = AbortSignal.timeout(55000);
  const observation: StorageNegativeObservation = {
    row,
    scenario,
    scope: "host-worker-subproof",
    owner: structuredClone(input.owner),
    calls: [],
    snapshots: [],
    trace: [],
    gaps: [
      "W10 authenticated JS/Python transport attachment and native core acceptance not executed by this producer",
      "Complete handle registry requires W10; record write projections and worker diagnostics alone are insufficient",
    ],
  };
  const call = async <M extends keyof StorageRequestMap>(
    method: M,
    params: StorageRequestMap[M]["params"],
    request = input.request,
    owner = input.owner,
  ) => {
    const start = performance.now();
    const result = await request({ ...principal, owner }, method, params, signal);
    observation.calls.push({
      method,
      params: structuredClone(params),
      result: structuredClone(result),
      start,
      end: performance.now(),
    });
    return result;
  };
  const snapshot = async (
    phase: string,
    env: Pick<StorageNegativeInput, "backend" | "owner" | "snapshot"> = input,
  ) => {
    observation.snapshots.push({
      phase,
      epoch: env.owner.hostEpoch,
      tree: await storageTree(input.root),
      quota: await env.backend.evidence.quota(env.owner).catch((error: unknown) => ({
        thrown: error instanceof Error ? error.message : String(error),
        result: (error as { result?: unknown }).result ?? null,
      })),
      durableRecovery: await env.backend.evidence.recoveryPage().catch((error: unknown) => ({
        thrown: error instanceof Error ? error.message : String(error),
      })),
      ...(await env.snapshot()),
    });
  };
  const payload = Buffer.from("original W09b payload"),
    replacement = Buffer.from("replacement W09b payload");
  const begin = async (
    bytes: Buffer,
    target: { mode: "create" } | { mode: "replace"; id: string; expectedRevision: string } = {
      mode: "create",
    },
  ) =>
    value(
      await call("storage/beginWrite", {
        target,
        kind: "negative.storage",
        schemaVersion: 1,
        label: "W09b",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256: storageHash(bytes),
      }),
    );
  const chunk = (write: string, bytes: Buffer) =>
    call("storage/writeChunk", { write, offset: 0, data: bytes.toString("base64") });
  const seed = async () => {
    const b = await begin(payload);
    value(await chunk(b.write, payload));
    value(await call("storage/sealWrite", { write: b.write }));
    return value(await call("storage/commitWrite", { write: b.write })).record;
  };
  const original = await seed();
  const finalChecks: (() => void)[] = [];
  let expected = original,
    expectedBytes = payload;
  let reopened: Awaited<ReturnType<StorageNegativeInput["reopen"]>> | undefined;
  try {
    await snapshot("before");
    if (["paged-delete", "generation-read", "idle-read", "pinned-replacement"].includes(scenario)) {
      const opened = value(
        await call("storage/openRead", {
          id: original.id,
          expectedRevision: original.revision,
          schemaVersion: 1,
        }),
      );
      if (scenario === "generation-read") {
        denied(
          await call(
            "storage/readChunk",
            { read: opened.read, offset: 0, maxBytes: 100 },
            input.request,
            { ...input.owner, generation: input.owner.generation + 1 },
          ),
          "PLUGIN_E_STALE_RESOURCE",
        );
      } else if (scenario === "idle-read") {
        const second = await seed();
        const page = value(await call("storage/list", { limit: 1 }));
        assert.ok(page.nextCursor);
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 30100));
        assert.ok(performance.now() - start >= 30000);
        denied(
          await call("storage/readChunk", { read: opened.read, offset: 0, maxBytes: 100 }),
          "PLUGIN_E_STALE_RESOURCE",
        );
        denied(
          await call("storage/list", { limit: 1, cursor: page.nextCursor }),
          "PLUGIN_E_STALE_RESOURCE",
        );
        value(await call("storage/delete", { id: second.id, expectedRevision: second.revision }));
      } else if (scenario === "paged-delete") {
        const second = await seed();
        const firstPage = value(await call("storage/list", { limit: 1 }));
        assert.ok(firstPage.nextCursor);
        value(await call("storage/delete", { id: second.id, expectedRevision: second.revision }));
        const secondPage = value(
          await call("storage/list", { limit: 1, cursor: firstPage.nextCursor }),
        );
        assert.deepEqual(
          [...firstPage.entries, ...secondPage.entries].map((r) => r.id).sort(),
          [original.id, second.id].sort(),
        );
        denied(
          await call("storage/list", { limit: 1, cursor: firstPage.nextCursor }, input.request, {
            ...input.owner,
            generation: input.owner.generation + 1,
          }),
          "PLUGIN_E_STALE_RESOURCE",
        );
      } else {
        const b = await begin(replacement, {
          mode: "replace",
          id: original.id,
          expectedRevision: original.revision,
        });
        value(await chunk(b.write, replacement));
        value(await call("storage/sealWrite", { write: b.write }));
        expected = value(await call("storage/commitWrite", { write: b.write })).record;
        expectedBytes = replacement;
        const quota = value(await call("storage/quota", {}));
        assert.ok(quota.pinnedBytes >= payload.length);
      }
      if (scenario !== "idle-read") {
        const read = value(
          await call("storage/readChunk", { read: opened.read, offset: 0, maxBytes: 100 }),
        );
        assert.equal(read.data, payload.toString("base64"));
        value(await call("storage/closeRead", { read: opened.read }));
      }
    } else if (
      ["corrupt-object", "unknown-version", "symlink-object", "hardlink-object"].includes(scenario)
    ) {
      await input.inject(scenario, original.id);
      // Validate through the actual worker on reopen, bypassing any warm metadata cache.
    } else {
      const b = await begin(replacement, {
        mode: "replace",
        id: original.id,
        expectedRevision: original.revision,
      });
      if (row === "N07") await input.inject(scenario, original.id);
      const written = await chunk(b.write, replacement);
      if (row === "N07" && scenario !== "short-write") {
        denied(
          written,
          "PLUGIN_E_STORAGE_IO",
          scenario === "EACCES"
            ? "permission"
            : scenario === "EROFS"
              ? "read-only"
              : ["ENOSPC", "EDQUOT"].includes(scenario)
                ? "disk-full"
                : "io",
        );
        await input.clearInjection();
        value(await call("storage/abortWrite", { write: b.write }));
      } else if (scenario === "incomplete-flush") {
        value(written);
        denied(await call("storage/flush", {}), "PLUGIN_E_STORAGE_CONFLICT", "flush-incomplete");
        value(await call("storage/abortWrite", { write: b.write }));
      } else {
        value(written);
        if (scenario === "seal-sync") input.fault.arm("seal-sync", "fail");
        const sealed = await call("storage/sealWrite", { write: b.write });
        if (scenario === "seal-sync") {
          denied(sealed, "PLUGIN_E_STORAGE_IO", "io");
          value(await call("storage/abortWrite", { write: b.write }));
        } else {
          value(sealed);
          if (scenario === "directory-EIO" || scenario === "cleanup-unlink")
            await input.inject(scenario, original.id);
          if (["object-rename", "after-publish", "head-dir-sync"].includes(scenario))
            input.fault.arm(
              scenario as "object-rename" | "after-publish" | "head-dir-sync",
              "fail",
            );
          if (scenario === "unknown-flush") input.fault.arm("after-publish", "fail");
          if (scenario === "fence-before-publish") {
            input.fault.arm("before-publish", "pause");
            const reached = input.fault.reached("before-publish");
            const pending = call("storage/commitWrite", { write: b.write });
            await reached;
            input.backend.engine.fence(input.owner, performance.now());
            input.fault.release("before-publish");
            const result = await pending;
            finalChecks.push(() => denied(result, "PLUGIN_E_STALE_RESOURCE"));
            value(await call("storage/abortWrite", { write: b.write }));
          } else {
            const committed = await call("storage/commitWrite", { write: b.write });
            if (["after-publish", "head-dir-sync", "unknown-flush"].includes(scenario)) {
              denied(committed, "PLUGIN_E_STORAGE_IO");
              assert.equal(
                (committed as { error: { detail?: { disposition?: string } } }).error.detail
                  ?.disposition,
                "unknown",
              );
              if (scenario === "unknown-flush")
                denied(
                  await call("storage/flush", {}),
                  "PLUGIN_E_STORAGE_CONFLICT",
                  "flush-incomplete",
                );
              // Reconcile this SAME write, never create a substitute publication.
              const status = value(await call("storage/writeStatus", { write: b.write }));
              assert.equal(status.state, "committed");
              expected = value(await call("storage/commitWrite", { write: b.write })).record;
              expectedBytes = replacement;
            } else if (["object-rename", "directory-EIO"].includes(scenario)) {
              denied(committed, "PLUGIN_E_STORAGE_IO");
              await input.clearInjection();
              value(await call("storage/abortWrite", { write: b.write }));
            } else {
              expected = value(committed).record;
              expectedBytes = replacement;
              if (scenario === "cleanup-unlink")
                assert.ok(value(await call("storage/quota", {})).temporaryBytes > 0);
            }
          }
        }
      }
    }
    await snapshot("after");
    if (
      expected.revision === original.revision &&
      !["corrupt-object", "unknown-version", "symlink-object", "hardlink-object"].includes(scenario)
    ) {
      const before = observation.snapshots[0]!.tree,
        after = observation.snapshots[1]!.tree;
      for (const [file, digest] of Object.entries(before))
        if (file.endsWith(`${path.sep}head.json`))
          assert.deepEqual(after[file], digest, "Failed operation mutated a committed head");
    }
    observation.trace = structuredClone(input.fault.trace());
    await input.clearInjection();
    reopened = await input.reopen();
    assert.notEqual(reopened.owner.hostEpoch, input.owner.hostEpoch);
    assert.equal(reopened.owner.sourceKey, input.owner.sourceKey);
    await snapshot("reopened", reopened);
    if (
      ["corrupt-object", "unknown-version", "symlink-object", "hardlink-object"].includes(scenario)
    ) {
      const stat = await call(
        "storage/stat",
        { id: original.id },
        reopened.request,
        reopened.owner,
      );
      if (scenario === "unknown-version") denied(stat, "PLUGIN_E_STORAGE_VERSION");
      else {
        if (stat.ok) {
          const opened = await call(
            "storage/openRead",
            { id: original.id, expectedRevision: original.revision, schemaVersion: 1 },
            reopened.request,
            reopened.owner,
          );
          denied(opened, "PLUGIN_E_STORAGE_IO");
        } else denied(stat, "PLUGIN_E_STORAGE_IO");
      }
    } else {
      const stat = value(
        await call("storage/stat", { id: original.id }, reopened.request, reopened.owner),
      );
      assert.deepEqual(stat.record, expected);
      const quota = value(await call("storage/quota", {}, reopened.request, reopened.owner));
      assert.equal(quota.recordCount, 1);
      assert.equal(quota.committedBytes, expected.byteLength);
      assert.equal(quota.reservedCreates, 0);
      assert.equal(quota.reservedBytes, 0);
      assert.equal(quota.pinnedBytes, 0);
      const opened = value(
        await call(
          "storage/openRead",
          { id: expected.id, expectedRevision: expected.revision, schemaVersion: 1 },
          reopened.request,
          reopened.owner,
        ),
      );
      const read = value(
        await call(
          "storage/readChunk",
          { read: opened.read, offset: 0, maxBytes: 100 },
          reopened.request,
          reopened.owner,
        ),
      );
      assert.equal(read.data, expectedBytes.toString("base64"));
      assert.equal(storageHash(Buffer.from(read.data, "base64")), expected.sha256);
      value(
        await call("storage/closeRead", { read: opened.read }, reopened.request, reopened.owner),
      );
    }
    for (const s of observation.snapshots) {
      if (s.core === null) observation.gaps.push(`${s.phase}: core snapshot unavailable`);
      if (s.handles === null)
        observation.gaps.push(`${s.phase}: complete handle registry unavailable`);
    }
    for (const check of finalChecks) check();
    return observation;
  } catch (error) {
    throw new Error(`W09b ${row}/${scenario} failed`, { cause: { error, observation } });
  } finally {
    input.fault.release("before-publish");
    await input.clearInjection();
    await reopened?.close();
  }
}

/** A subproof cannot be promoted to the entire matrix by dropping gaps. */
export function assertStorageNegativeObservation(o: StorageNegativeObservation): void {
  assert.equal(o.scope, "host-worker-subproof");
  assert.ok((storageNegativeScenarios[o.row] as readonly string[]).includes(o.scenario));
  assert.ok(o.calls.length > 0);
  assert.deepEqual(
    o.snapshots.map((s) => s.phase),
    ["before", "after", "reopened"],
  );
  assert.notEqual(o.snapshots[0]!.epoch, o.snapshots[2]!.epoch);
  for (const s of o.snapshots) {
    assert.ok(s.quota && typeof s.quota === "object");
    for (const file of Object.values(s.tree)) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    }
  }
  assert.ok(o.gaps.length > 0, "Native acceptance requires W10, not relabelled subproofs");
}
