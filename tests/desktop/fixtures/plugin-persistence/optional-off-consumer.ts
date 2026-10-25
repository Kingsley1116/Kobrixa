import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PluginContext, PersistenceDrainContext } from "@kobrixa/plugin-sdk";
import type { RecordMeta } from "@kobrixa/plugin-protocol";
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("Optional-off public call failed");
  return r.value;
};
/** No evidence DTOs cross this channel: the host observes the original SDK calls. */
export function installOptionalOffConsumer(ctx: PluginContext) {
  let record: RecordMeta | undefined;
  const bytes = (final: boolean) =>
    Buffer.from(`Optional-off ${final ? "sealed final" : "committed checkpoint"}\n`);
  const meta = (final: boolean) => ({
    kind: "test.optional-off",
    schemaVersion: 1,
    label: "Optional-off",
    mediaType: "application/octet-stream" as const,
    byteLength: bytes(final).length,
    sha256: createHash("sha256").update(bytes(final)).digest("hex"),
  });
  ctx.commands.register(`${ctx.pluginId}.optional-off-seed`, async () => {
    assert.equal(record, undefined);
    const inventory = value(await ctx.devices.list({}));
    const provider = inventory.providers.find((p) => p.state === "available");
    assert.ok(provider);
    const discovered = value(await ctx.devices.discover({ providerId: provider.providerId }));
    assert.ok(discovered.candidates[0]);
    const session = value(
      await ctx.devices.connect({
        target: { kind: "candidate", candidateId: discovered.candidates[0].candidateId },
      }),
    ).session;
    const current = value(await ctx.devices.session({ sessionId: session.sessionId }));
    const channel = current.sources.channels.find((c) => c.kind === "input" && c.state === "ready");
    assert.ok(channel);
    const reservation = value(
      await ctx.devices.recording.reserve({
        sessionId: session.sessionId,
        channelIds: [channel.channelId],
        expectedSourceRevision: current.sources.sourceRevision,
      }),
    ).reservation;
    const write = value(
      await ctx.storage.beginWrite({ ...meta(false), target: { mode: "create" } }),
    );
    value(
      await ctx.storage.writeChunk({
        write: write.write,
        offset: 0,
        data: bytes(false).toString("base64"),
      }),
    );
    value(await ctx.storage.sealWrite({ write: write.write }));
    record = value(await ctx.storage.commitWrite({ write: write.write })).record;
    value(
      await ctx.storage.registerCheckpoint({
        id: record.id,
        expectedRevision: record.revision,
        reservation: reservation.reservationId,
      }),
    );
  });
  return async ({ request, storage }: PersistenceDrainContext) => {
    if (!record) return undefined;
    const checkpoint = request.checkpoints.find((c) => c.record.id === record!.id);
    assert.ok(checkpoint);
    const write = value(
      await storage.beginWrite({
        ...meta(true),
        target: { mode: "replace", id: record.id, expectedRevision: record.revision },
        checkpoint: { handle: checkpoint.checkpoint, phase: "final" },
        drainToken: request.token,
      }),
    );
    value(
      await storage.writeChunk({
        write: write.write,
        offset: 0,
        data: bytes(true).toString("base64"),
      }),
    );
    value(await storage.sealWrite({ write: write.write }));
    const result = await storage.commitWrite({ write: write.write, drainToken: request.token });
    assert.equal(
      result.ok,
      false,
      "Controller must inject exactly one real prepublication I/O failure",
    );
    if (!result.ok) assert.equal(result.error.code, "PLUGIN_E_STORAGE_IO");
    assert.equal(value(await storage.writeStatus({ write: write.write })).state, "sealed");
    return { ok: true as const, value: { status: "submitted" as const, writes: [write.write] } };
  };
}
