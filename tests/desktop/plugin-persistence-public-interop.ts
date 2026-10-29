import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { PluginProcess } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  approvedHost,
  verifyCompatibility,
  type Wire,
} from "./plugin-persistence-compatibility.js";

export const INTEROP_IDS = ["acceptance.interop-js", "acceptance.interop-python"] as const;
export const COMPATIBILITY_REFERENCE = {
  commit: "337e1a7a473d523b2963bf61ad4693124f3631de",
  file: "docs/superpowers/evidence/2026-10-30-3b2-compatibility/evidence.json.gz",
  sha256: "9d52a49785baa7a3f6ede0453f1f90d0ac973d5cb2a3bf12a7e5e6cdb5ac6686",
} as const;
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const one = <T>(rows: T[], label: string): T => {
  assert.equal(rows.length, 1, label);
  return rows[0]!;
};
export type InteropWire = { sequence: number; direction: "host" | "plugin"; message: Wire };
export type InteropConsumer = {
  owner: ResourceOwner;
  transport: "message-port" | "stdio";
  launch: number;
  wire: InteropWire[];
  output: Array<{ sequence: number; line: string }>;
  exit?: { sequence: number; code: number | null; signal?: string | null };
  drain?: { sequence: number; offer: Wire; report: Wire };
  actions: Array<{
    sequence: number;
    kind: "mint" | "claim" | "export-file" | "clipboard-write";
    actionRef: string;
    invocationId?: string;
    data: Wire;
  }>;
};

/** Observation-only original transport forwarding. Install before launcher listeners can fire. */
export function publicInteropObserver() {
  const consumers: InteropConsumer[] = [];
  let sequence = 0;
  const next = () => ++sequence;
  return {
    consumers,
    begin(owner: ResourceOwner, transport: InteropConsumer["transport"]) {
      assert.ok(INTEROP_IDS.includes(owner.pluginId as (typeof INTEROP_IDS)[number]));
      const row: InteropConsumer = {
        owner: structuredClone(owner),
        transport,
        launch: next(),
        wire: [],
        output: [],
        actions: [],
      };
      consumers.push(row);
      return row;
    },
    output(row: InteropConsumer, line: string) {
      row.output.push({ sequence: next(), line });
    },
    attach(row: InteropConsumer, child: PluginProcess): PluginProcess {
      const off = child.onMessage((text) =>
        row.wire.push({ sequence: next(), direction: "plugin", message: JSON.parse(text) }),
      );
      child.onExit((exit) => {
        row.exit = { ...exit, sequence: next() };
        off();
      });
      return {
        ...child,
        send(text) {
          row.wire.push({ sequence: next(), direction: "host", message: JSON.parse(text) });
          child.send(text);
        },
      };
    },
    // Call only around the actual ledger/adapter/participant operations; no success defaults.
    action(row: InteropConsumer, event: Omit<InteropConsumer["actions"][number], "sequence">) {
      row.actions.push({ ...structuredClone(event), sequence: next() });
    },
    drain(row: InteropConsumer, offer: Wire, report: Wire) {
      row.drain = {
        sequence: next(),
        offer: structuredClone(offer),
        report: structuredClone(report),
      };
    },
  };
}
export function interopOutputs(row: InteropConsumer, phase: string) {
  return row.output.flatMap((entry) => {
    const index = entry.line.indexOf("PUBLIC_INTEROP:");
    if (index < 0) return [];
    const parsed = JSON.parse(entry.line.slice(index + 15));
    assert.equal(parsed.pluginId, row.owner.pluginId);
    return parsed.phase === phase ? [{ ...parsed, sequence: entry.sequence }] : [];
  });
}
export function interopPairs(
  row: InteropConsumer,
  method: string,
  direction: "plugin" | "host" = "plugin",
) {
  return row.wire
    .filter((w) => w.direction === direction && w.message.method === method)
    .map((request) => {
      assert.notEqual(request.message.id, undefined, `${method} must be a request`);
      const response = one(
        row.wire.filter(
          (w) =>
            w.direction !== direction && !w.message.method && w.message.id === request.message.id,
        ),
        `${method} exact response`,
      );
      assert.ok(response.sequence > request.sequence, `${method} response order`);
      assert.equal(response.message.error, undefined, `${method} transport error`);
      return { request, response, params: request.message.params, result: response.message.result };
    });
}
const business = (pair: ReturnType<typeof interopPairs>[number]) => {
  assert.equal(pair.result?.ok, true, `${pair.request.message.method} business failure`);
  assert.ok(
    pair.result.value && typeof pair.result.value === "object",
    "Missing nested business value",
  );
  return pair.result.value as Wire;
};

/** Read existing bytes; never regenerate/relabel the twenty archived negotiation runs. */
export async function readInteropIdentity(root: string) {
  const compressed = await readFile(path.join(root, COMPATIBILITY_REFERENCE.file));
  assert.equal(sha(compressed), COMPATIBILITY_REFERENCE.sha256, "Archived receipt identity");
  const archived = JSON.parse(gunzipSync(compressed).toString());
  const raw = one<Wire>(archived.reports, "One compatibility report").evidence.compatibility;
  verifyCompatibility(raw);
  assert.equal(raw.currentCommit, COMPATIBILITY_REFERENCE.commit);
  const source = await readFile(path.join(root, "packages/plugin-protocol/src/limits.ts"), "utf8");
  const hostVersion = /PLUGIN_API_VERSION = "([^"]+)"/.exec(source)?.[1];
  assert.ok(hostVersion);
  const published = approvedHost(hostVersion);
  const protocol = await readFile(
    path.join(root, "packages/plugin-protocol/schema/plugin-protocol.schema.json"),
  );
  const python = await readFile(path.join(root, "sdks/python/kobrixa/plugin-protocol.schema.json"));
  assert.equal(sha(protocol), sha(python));
  assert.equal(
    JSON.parse(protocol.toString()).$id,
    `https://kobrixa.com/schemas/plugin-protocol/${hostVersion}.json`,
  );
  const expected: Record<string, string> = {};
  for (const entry of raw.cases.filter((c: Wire) => c.slot === 4))
    for (const [file, hash] of Object.entries(entry.sourceHashes)) {
      assert.ok(
        /^(packages\/plugin-(protocol|sdk-js)\/|sdks\/python\/)/.test(file) &&
          !file.split("/").includes(".."),
      );
      if (/\.test\.|\/tests\//.test(file)) continue;
      if (expected[file]) assert.equal(expected[file], hash);
      expected[file] = String(hash);
    }
  assert.ok(Object.keys(expected).length > 10);
  const current: Record<string, string> = {};
  const changed: string[] = [];
  for (const [file, digest] of Object.entries(expected)) {
    current[file] = sha(await readFile(path.join(root, file)));
    if (current[file] !== digest) changed.push(file);
  }
  return {
    hostVersion,
    publicApi18Published: published,
    limitsSha256: sha(source),
    schemaSha256: sha(protocol),
    runtimeHashes: current,
    compatibility: {
      ...COMPATIBILITY_REFERENCE,
      applicability: changed.length ? "historical-only" : "same-runtime",
      changed,
    },
  };
}

export function verifyInteropWatch(row: InteropConsumer) {
  const watch = one(interopPairs(row, "settings/watch"), "One actual watch");
  const baseline = business(watch);
  const delivery = one(
    row.wire.filter(
      (w) =>
        w.direction === "host" &&
        w.message.method === "events/deliver" &&
        w.message.params.kind === "settings.changed" &&
        w.message.params.subscriptionId === baseline.subscriptionId,
    ),
    "settings delivery",
  );
  const event = delivery.message.params;
  assert.ok(event.sequence > baseline.sequence);
  const ack = one(
    interopPairs(row, "events/ack").filter(
      (p) =>
        p.params.subscriptionId === event.subscriptionId && p.params.sequence === event.sequence,
    ),
    "Exact event ACK",
  );
  assert.ok(business(ack).acknowledged >= event.sequence);
  const entered = one(interopOutputs(row, "callback-enter"), "Actual callback");
  const released = one(interopOutputs(row, "callback-release"), "Explicit release");
  const completed = one(interopOutputs(row, "callback-complete"), "Callback completion");
  assert.deepEqual(entered.data, event);
  assert.deepEqual(completed.data, event);
  assert.ok(
    delivery.sequence < entered.sequence &&
      entered.sequence < released.sequence &&
      released.sequence < completed.sequence,
  );
  assert.ok(
    delivery.sequence < ack.request.sequence && ack.response.sequence < released.sequence,
    "ACK must not wait for slow callback",
  );
  const updates = interopPairs(row, "settings/update");
  assert.equal(updates.length, 2);
  const saved = business(updates[0]!);
  const denied = updates[1]!;
  assert.equal(denied.result.ok, false);
  assert.equal(denied.result.error.code, "PLUGIN_E_SETTINGS_CONFLICT");
  assert.equal(updates[0]!.params.expectedRevision, denied.params.expectedRevision);
  assert.notEqual(saved.snapshot.revision, denied.params.expectedRevision);
  assert.ok(
    interopPairs(row, "settings/read").some(
      (p) =>
        p.request.sequence > denied.response.sequence &&
        business(p).revision === saved.snapshot.revision,
    ),
  );
  const unwatch = interopPairs(row, "events/unsubscribe");
  assert.equal(unwatch.length, 2);
  assert.deepEqual(
    unwatch.map((p) => p.params.subscriptionId),
    [baseline.subscriptionId, baseline.subscriptionId],
  );
  assert.deepEqual(
    unwatch.map((p) => business(p).removed),
    [true, false],
  );
  assert.ok(completed.sequence < unwatch[0]!.request.sequence);
  assert.equal(interopPairs(row, "settings/unwatch").length, 0);
}

export function verifyInteropRecords(row: InteropConsumer, other: InteropConsumer) {
  const created = one(interopOutputs(row, "records"), "Original records");
  const verified = one(interopOutputs(row, "verified"), "Post-foreign verification");
  const records: Wire[] = created.data.records;
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((r) => r.id)).size, 2);
  assert.deepEqual(verified.data.records, records);
  assert.deepEqual(verified.data.quota, created.data.quota);
  const foreign = one(interopOutputs(other, "records"), "Foreign records").data;
  for (const method of ["storage/openRead", "storage/readChunk"]) {
    const denied = one(
      interopPairs(row, method).filter((p) =>
        method.endsWith("openRead")
          ? p.params.id === foreign.records[0].id
          : p.params.read === foreign.read,
      ),
      "Actual foreign request",
    );
    assert.equal(denied.result.ok, false);
    assert.ok(
      ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE"].includes(denied.result.error.code),
    );
    assert.ok(
      created.sequence < denied.request.sequence && denied.response.sequence < verified.sequence,
    );
  }
  const pages = interopPairs(row, "storage/list");
  assert.ok(pages.length >= 2);
  let cursor: string | undefined;
  const listed: string[] = [];
  for (const page of pages) {
    assert.equal(page.params.limit, 1);
    assert.equal(page.params.cursor, cursor);
    const value = business(page);
    assert.ok(value.entries.length <= 1);
    listed.push(...value.entries.map((r: Wire) => r.id));
    cursor = value.nextCursor ?? undefined;
  }
  assert.equal(cursor, undefined);
  assert.deepEqual(listed.sort(), records.map((r) => r.id).sort());
  for (const [index, record] of records.entries()) {
    const expected = Buffer.alloc(262181, 97 + index);
    const digest = sha(expected);
    assert.equal(record.byteLength, expected.length);
    assert.equal(record.sha256, digest);
    const begin = one(
      interopPairs(row, "storage/beginWrite").filter(
        (p) => p.params.target.mode === "create" && business(p).id === record.id,
      ),
      "Record begin",
    );
    const handle = business(begin).write;
    const chunks = interopPairs(row, "storage/writeChunk").filter((p) => p.params.write === handle);
    assert.equal(chunks.length, 3);
    assert.deepEqual(chunks[0]!.params, chunks[1]!.params);
    const payload = Buffer.concat(
      [chunks[0]!, chunks[2]!].map((p) => {
        business(p);
        return Buffer.from(p.params.data, "base64");
      }),
    );
    assert.deepEqual(payload, expected);
    assert.deepEqual(
      chunks.map((p) => p.params.offset),
      [0, 0, 262144],
    );
    const seal = one(
      interopPairs(row, "storage/sealWrite").filter((p) => p.params.write === handle),
      "Seal",
    );
    business(seal);
    assert.ok(chunks[2]!.response.sequence < seal.request.sequence);
    const commits = interopPairs(row, "storage/commitWrite").filter(
      (p) => p.params.write === handle,
    );
    assert.equal(commits.length, 2);
    assert.ok(seal.response.sequence < commits[0]!.request.sequence);
    assert.deepEqual(business(commits[0]!).record, record);
    assert.deepEqual(business(commits[0]!).receipt, business(commits[1]!).receipt);
    const reads = interopPairs(row, "storage/openRead").filter(
      (p) => p.params.id === record.id && p.result.ok,
    );
    let verifiedBefore = false,
      verifiedAfter = false;
    for (const read of reads) {
      const handle = business(read).read;
      const chunks = interopPairs(row, "storage/readChunk").filter(
        (p) => p.params.read === handle && p.result.ok,
      );
      if (!chunks.length) continue; // Extra held handle is used by the foreign-owner test.
      let offset = 0;
      const hash = createHash("sha256");
      for (const chunk of chunks) {
        const value = business(chunk),
          bytes = Buffer.from(value.data, "base64");
        assert.equal(chunk.params.offset, offset);
        assert.ok(
          bytes.length > 0 && bytes.length <= chunk.params.maxBytes && bytes.length <= 262144,
        );
        offset += bytes.length;
        assert.equal(value.nextOffset, offset);
        assert.equal(value.eof, offset === expected.length);
        hash.update(bytes);
      }
      assert.equal(offset, expected.length);
      assert.equal(hash.digest("hex"), digest);
      business(
        one(
          interopPairs(row, "storage/closeRead").filter((p) => p.params.read === handle),
          "Read closed",
        ),
      );
      if (read.request.sequence < created.sequence) verifiedBefore = true;
      if (read.request.sequence > created.sequence && read.response.sequence < verified.sequence)
        verifiedAfter = true;
    }
    assert.ok(verifiedBefore && verifiedAfter, "Public full hash before and after foreign calls");
  }
}

export function verifyInteropActions(row: InteropConsumer) {
  const refs: string[] = [];
  for (const action of ["export", "copy"]) {
    const output = one(interopOutputs(row, action), `Actual ${action}`);
    const invocation = one(
      interopPairs(row, "command/invoke", "host").filter(
        (p) => p.params.command === `${row.owner.pluginId}.interop-${action}`,
      ),
      "Context invocation",
    );
    const ref = invocation.params.context.actionRef;
    assert.ok(ref);
    refs.push(ref);
    assert.equal(output.data.actionRef, ref);
    assert.equal(output.data.invocationId, invocation.params.invocationId);
    business(invocation);
    const mint = one(
      row.actions.filter((a) => a.kind === "mint" && a.actionRef === ref),
      "Actual ledger mint",
    );
    const claim = one(
      row.actions.filter((a) => a.kind === "claim" && a.actionRef === ref),
      "Actual ledger claim",
    );
    assert.deepEqual(mint.data.owner, row.owner);
    assert.deepEqual(claim.data.owner, row.owner);
    assert.equal(claim.data.ok, true);
    assert.equal(claim.data.capability, action === "export" ? "storage.export" : "ui.clipboard");
    assert.ok(
      mint.sequence < invocation.request.sequence && invocation.request.sequence < claim.sequence,
    );
    if (action === "copy") {
      const call = one(
        interopPairs(row, "ui/copyText").filter((p) => p.params.actionRef === ref && p.result.ok),
        "Public copy",
      );
      business(call);
      const write = one(
        row.actions.filter((a) => a.kind === "clipboard-write" && a.actionRef === ref),
        "Actual clipboard write",
      );
      assert.equal(write.data.text, "Synthetic persistence fixture");
      assert.ok(
        call.request.sequence < claim.sequence &&
          claim.sequence < write.sequence &&
          write.sequence < call.response.sequence,
      );
    } else {
      const begin = one(
        interopPairs(row, "storage/exportBegin").filter((p) => p.params.actionRef === ref),
        "Public export",
      );
      const job = business(begin).export;
      const chunk = one(
        interopPairs(row, "storage/exportChunk").filter((p) => p.params.export === job),
        "Export chunk",
      );
      business(chunk);
      const commit = one(
        interopPairs(row, "storage/exportCommit").filter((p) => p.params.export === job),
        "Export commit",
      );
      business(commit);
      assert.equal(chunk.params.offset, 0);
      assert.equal(
        Buffer.from(chunk.params.data, "base64").toString(),
        "Synthetic persistence export\n",
      );
      const file = one(
        row.actions.filter((a) => a.kind === "export-file" && a.actionRef === ref),
        "Outside file readback",
      );
      assert.equal(file.data.sha256, sha("Synthetic persistence export\n"));
      assert.equal(file.data.byteLength, 29);
      assert.ok(
        begin.request.sequence < claim.sequence &&
          claim.sequence < chunk.request.sequence &&
          chunk.response.sequence < commit.request.sequence &&
          commit.response.sequence < file.sequence,
      );
    }
  }
  assert.equal(new Set(refs).size, 2, "Separate one-use actions");
  assert.equal(row.actions.filter((a) => a.kind === "clipboard-write").length, 1);
  assert.equal(row.actions.filter((a) => a.kind === "export-file").length, 1);
  const replay = one(
    interopPairs(row, "ui/copyText").filter((p) => !p.result.ok),
    "Actual replay denial",
  );
  assert.equal(replay.params.actionRef, refs[1]);
  assert.equal(replay.result.error.code, "PLUGIN_E_PERMISSION_DENIED");
}

export function verifyInteropDrain(row: InteropConsumer) {
  const drain = one(interopPairs(row, "storage/drain", "host"), "Actual drain");
  const result = business(drain);
  assert.equal(result.status, "submitted");
  assert.equal(result.writes.length, 1);
  assert.equal(drain.params.checkpoints.length, 1);
  const final = one(
    interopPairs(row, "storage/beginWrite").filter((p) => p.params.checkpoint?.phase === "final"),
    "Final write",
  );
  assert.equal(final.params.drainToken, drain.params.token);
  assert.equal(final.params.checkpoint.handle, drain.params.checkpoints[0].checkpoint);
  assert.equal(final.params.target.id, drain.params.checkpoints[0].record.id);
  assert.equal(business(final).write, result.writes[0]);
  const commit = interopPairs(row, "storage/commitWrite").filter(
    (p) => p.params.write === result.writes[0],
  );
  assert.ok(commit.length > 0);
  for (const c of commit) {
    assert.equal(c.params.drainToken, drain.params.token);
    assert.equal(business(c).record.checkpoint, "final");
  }
  assert.ok(
    drain.request.sequence < final.request.sequence &&
      commit.at(-1)!.response.sequence < drain.response.sequence,
  );
  assert.ok(
    interopPairs(row, "storage/flush").some(
      (p) =>
        p.request.sequence > commit.at(-1)!.response.sequence &&
        p.response.sequence < drain.response.sequence &&
        business(p),
    ),
  );
  assert.ok(row.drain);
  assert.deepEqual(row.drain.offer.owner, row.owner);
  assert.equal(row.drain.offer.token, drain.params.token);
  assert.equal(row.drain.report.state, "saved");
  assert.equal(row.drain.report.blocker, false);
  assert.equal(row.drain.report.pendingSettings, false);
  assert.deepEqual(row.drain.report.errors, []);
  assert.equal(row.drain.report.records.length, 1);
  assert.equal(row.drain.report.records[0].id, final.params.target.id);
  assert.equal(row.drain.report.records[0].final, true);
  assert.ok(
    drain.response.sequence < row.drain.sequence && row.drain.sequence < row.exit!.sequence,
  );
}

/** Pure outside raw-operation oracle. Controller must also verify artifacts and OS cleanup. */
export function verifyPublicInterop(
  consumers: InteropConsumer[],
  identity: Awaited<ReturnType<typeof readInteropIdentity>>,
) {
  assert.equal(consumers.length, 2);
  assert.deepEqual(consumers.map((r) => r.owner.pluginId).sort(), [...INTEROP_IDS].sort());
  assert.deepEqual(consumers.map((r) => r.transport).sort(), ["message-port", "stdio"]);
  assert.equal(identity.publicApi18Published, approvedHost(identity.hostVersion));
  assert.equal(identity.compatibility.sha256, COMPATIBILITY_REFERENCE.sha256);
  const pids = new Set<number>();
  for (const row of consumers) {
    const boot = one(interopOutputs(row, "boot"), "Process boot");
    assert.ok(Number.isSafeInteger(boot.pid) && boot.pid > 0 && !pids.has(boot.pid));
    pids.add(boot.pid);
    assert.ok(row.exit && row.exit.code === 0);
    assert.ok(row.launch < boot.sequence && boot.sequence < row.exit.sequence);
    let seq = row.launch;
    for (const wire of row.wire) {
      assert.ok(seq < wire.sequence && wire.sequence < row.exit.sequence);
      seq = wire.sequence;
    }
    const init = one(interopPairs(row, "initialize", "host"), "Actual negotiation");
    assert.equal(init.params.pluginId, row.owner.pluginId);
    assert.equal(init.params.apiVersion, identity.hostVersion);
    assert.equal(init.result.apiVersion, identity.hostVersion);
    assert.equal(
      init.result.sdk.name,
      row.transport === "stdio" ? "kobrixa-plugin-sdk" : "@kobrixa/plugin-sdk",
    );
    verifyInteropWatch(row);
    verifyInteropRecords(
      row,
      consumers.find((r) => r !== row)!,
    );
    verifyInteropActions(row);
    verifyInteropDrain(row);
  }
  return {
    status: "public-interop-subset",
    fullStage3Pass: false,
    compatibilityReference: identity.compatibility,
  };
}

/** Only main's real composition supplies these operations; no alternate RPC handlers. */
export interface InteropComposition {
  consumers: InteropConsumer[];
  execute(id: (typeof INTEROP_IDS)[number], suffix: string): Promise<void>;
  invoke(
    id: (typeof INTEROP_IDS)[number],
    suffix: string,
    args: Record<string, string>,
  ): Promise<void>;
  retire(id: (typeof INTEROP_IDS)[number]): Promise<void>;
}
export async function runPublicInterop(deps: InteropComposition) {
  const row = (id: string) =>
    one(
      deps.consumers.filter((r) => r.owner.pluginId === id),
      "Original consumer",
    );
  const wait = async (check: () => boolean) => {
    const until = performance.now() + 10000;
    while (!check()) {
      assert.ok(performance.now() < until, "Interop observation timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const settle = async (work: Promise<void>[]) => {
    const results = await Promise.allSettled(work);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((r) => r.reason),
        "Interop operation failed",
      );
  };
  let failure: unknown;
  try {
    for (const id of INTEROP_IDS) {
      await deps.execute(id, "interop-watch");
      await wait(
        () =>
          interopOutputs(row(id), "callback-enter").length === 1 &&
          row(id).wire.some(
            (ack) =>
              ack.direction === "plugin" &&
              ack.message.method === "events/ack" &&
              row(id).wire.some(
                (reply) =>
                  reply.direction === "host" &&
                  !reply.message.method &&
                  reply.message.id === ack.message.id &&
                  reply.message.result?.ok === true,
              ),
          ),
      );
      await deps.execute(id, "interop-release");
      await deps.execute(id, "interop-records");
    }
    for (const id of INTEROP_IDS) {
      const other = one(
        interopOutputs(row(INTEROP_IDS.find((x) => x !== id)!), "records"),
        "Foreign output",
      ).data;
      await deps.invoke(id, "interop-foreign", {
        id: other.records[0].id,
        revision: other.records[0].revision,
        read: other.read,
      });
    }
    for (const id of INTEROP_IDS) {
      await deps.execute(id, "interop-verify");
      await deps.invoke(id, "interop-export", {});
      await deps.invoke(id, "interop-copy", {});
      const copied = one(interopOutputs(row(id), "copy"), "Copy output");
      await deps.invoke(id, "interop-replay", { actionRef: copied.data.actionRef });
      await deps.execute(id, "interop-checkpoint");
    }
  } catch (error) {
    failure = error;
  }
  try {
    await settle(
      INTEROP_IDS.filter((id) => deps.consumers.some((r) => r.owner.pluginId === id)).map((id) =>
        deps.retire(id),
      ),
    );
  } catch (cleanup) {
    if (failure)
      throw new AggregateError([failure, cleanup], "Interop failed and cleanup failed", {
        cause: failure,
      });
    throw cleanup;
  }
  if (failure) throw failure;
}
