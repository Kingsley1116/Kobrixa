import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PluginContext, PersistenceDrainContext } from "@kobrixa/plugin-sdk";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("TTL fixture public call failed");
  return r.value;
};
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** State stays in the original consumer; host observations come from actual calls. */
export function installSealedTtlConsumer(ctx: PluginContext) {
  const states = new Map<
    string,
    { record: RecordMeta; reservation: string; read?: string; write?: string }
  >();
  let active: "sealed" | "incomplete" | undefined;
  let drained: (() => void) | undefined;
  const bytes = (kind: string, final = false) =>
    Buffer.from(`TTL ${kind} ${final ? "complete final replacement" : "original checkpoint"}\n`);
  const metadata = (kind: string, final = false) => ({
    kind: `test.ttl-${kind}`,
    schemaVersion: 1,
    label: `TTL ${kind}`,
    mediaType: "application/octet-stream" as const,
    byteLength: bytes(kind, final).length,
    sha256: digest(bytes(kind, final)),
  });
  async function reserve() {
    const inventory = value(await ctx.devices.list({}));
    const provider = inventory.providers.find((p) => p.state === "available");
    assert.ok(provider);
    let session = inventory.sessions.find(
      (s) => s.providerId === provider.providerId && s.state === "connected",
    );
    if (!session) {
      const discovered = value(await ctx.devices.discover({ providerId: provider.providerId }));
      assert.ok(discovered.candidates[0]);
      session = value(
        await ctx.devices.connect({
          target: { kind: "candidate", candidateId: discovered.candidates[0].candidateId },
        }),
      ).session;
    }
    const current = value(await ctx.devices.session({ sessionId: session.sessionId }));
    const channel = current.sources.channels.find((c) => c.kind === "input" && c.state === "ready");
    assert.ok(channel);
    return value(
      await ctx.devices.recording.reserve({
        sessionId: session.sessionId,
        channelIds: [channel.channelId],
        expectedSourceRevision: current.sources.sourceRevision,
      }),
    ).reservation.reservationId;
  }
  async function read(kind: string, retain: boolean) {
    const state = states.get(kind)!;
    const opened = value(
      await ctx.storage.openRead({
        id: state.record.id,
        expectedRevision: state.record.revision,
        schemaVersion: 1,
      }),
    );
    const chunk = value(
      await ctx.storage.readChunk({ read: opened.read, offset: 0, maxBytes: 262144 }),
    );
    assert.equal(chunk.eof, true);
    assert.deepEqual(Buffer.from(chunk.data, "base64"), bytes(kind));
    if (retain) state.read = opened.read;
    else value(await ctx.storage.closeRead({ read: opened.read }));
  }
  for (const step of [
    "seed-sealed",
    "drain-sealed",
    "status",
    "expired",
    "read-sealed",
    "seed-incomplete",
    "drain-incomplete",
    "read-incomplete",
    "cleanup",
  ] as const) {
    ctx.commands.register(`${ctx.pluginId}.ttl-${step}`, async () => {
      if (step.startsWith("seed-")) {
        const kind = step.slice(5);
        const reservation = await reserve();
        const stage = value(
          await ctx.storage.beginWrite({ ...metadata(kind), target: { mode: "create" } }),
        );
        value(
          await ctx.storage.writeChunk({
            write: stage.write,
            offset: 0,
            data: bytes(kind).toString("base64"),
          }),
        );
        value(await ctx.storage.sealWrite({ write: stage.write }));
        const { record } = value(await ctx.storage.commitWrite({ write: stage.write }));
        states.set(kind, { record, reservation });
        value(
          await ctx.storage.registerCheckpoint({
            id: record.id,
            expectedRevision: record.revision,
            reservation,
          }),
        );
        if (kind === "sealed") await read(kind, true);
      } else if (step.startsWith("drain-")) {
        const kind = step.slice(6) as "sealed" | "incomplete";
        active = kind;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = new Promise<void>((resolve, reject) => {
          drained = resolve;
          timer = setTimeout(
            () => reject(new Error("TTL original SDK drain did not finish")),
            9000,
          );
        });
        try {
          value(
            await ctx.devices.recording.release({ reservationId: states.get(kind)!.reservation }),
          );
          await done;
        } finally {
          clearTimeout(timer);
          drained = undefined;
          active = undefined;
        }
      } else if (step === "status") {
        const state = value(await ctx.storage.writeStatus({ write: states.get("sealed")!.write! }));
        assert.equal(state.state, "sealed");
      } else if (step === "expired") {
        const state = states.get("sealed")!;
        const pin = await ctx.storage.readChunk({ read: state.read!, offset: 0, maxBytes: 262144 });
        assert.equal(pin.ok, false);
        const commit = await ctx.storage.commitWrite({ write: state.write! });
        assert.equal(commit.ok, false);
        const status = value(await ctx.storage.writeStatus({ write: state.write! }));
        assert.equal(status.state, "expired");
      } else if (step.startsWith("read-")) await read(step.slice(5), false);
      else {
        for (const state of states.values()) {
          if (state.read) await ctx.storage.closeRead({ read: state.read });
          if (state.write) await ctx.storage.abortWrite({ write: state.write });
          await ctx.devices.recording.release({ reservationId: state.reservation });
        }
      }
    });
  }
  return async ({ request, storage }: PersistenceDrainContext) => {
    if (!active) return undefined;
    const kind = active;
    const state = states.get(kind)!;
    try {
      const target = request.checkpoints.find((c) => c.record.id === state.record.id);
      assert.ok(target);
      const stage = value(
        await storage.beginWrite({
          ...metadata(kind, true),
          target: { mode: "replace", id: state.record.id, expectedRevision: state.record.revision },
          checkpoint: { handle: target.checkpoint, phase: "final" },
          drainToken: request.token,
        }),
      );
      state.write = stage.write;
      const payload = bytes(kind, true);
      const sent = kind === "sealed" ? payload : payload.subarray(0, 5);
      value(
        await storage.writeChunk({ write: stage.write, offset: 0, data: sent.toString("base64") }),
      );
      if (kind === "sealed") {
        value(await storage.sealWrite({ write: stage.write }));
        const result = await storage.commitWrite({ write: stage.write, drainToken: request.token });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, "PLUGIN_E_STORAGE_IO");
        assert.equal(value(await storage.writeStatus({ write: stage.write })).state, "sealed");
      }
      return {
        ok: true as const,
        value: {
          status: kind === "sealed" ? ("submitted" as const) : ("checkpoint-only" as const),
          writes: kind === "sealed" ? [stage.write] : [],
        },
      };
    } finally {
      drained?.();
    }
  };
}
