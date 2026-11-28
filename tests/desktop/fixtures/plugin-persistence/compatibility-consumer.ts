import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("Public storage failure");
  return r.value;
};
const bytes = Buffer.from("compatibility checkpoint\n");
const metadata = {
  kind: "test.compatibility",
  schemaVersion: 1,
  label: "Compatibility",
  mediaType: "text/plain" as const,
  byteLength: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
void runPlugin(
  definePlugin({
    activate(ctx) {
      ctx.commands.register(`${ctx.pluginId}.legacy`, async () => {
        console.error(`UI_LEGACY_EXECUTED:${ctx.pluginId}`);
      });
      ctx.commands.register(`${ctx.pluginId}.seed`, async () => {
        const write = value(
          await ctx.storage.beginWrite({ ...metadata, target: { mode: "create" } }),
        );
        value(
          await ctx.storage.writeChunk({
            write: write.write,
            offset: 0,
            data: bytes.toString("base64"),
          }),
        );
        value(await ctx.storage.sealWrite({ write: write.write }));
        const saved = value(await ctx.storage.commitWrite({ write: write.write }));
        value(
          await ctx.storage.registerCheckpoint({
            id: saved.record.id,
            expectedRevision: saved.record.revision,
          }),
        );
      });
    },
    async drain({ request, storage }) {
      assert.equal(request.checkpoints.length, 1);
      const writes: string[] = [];
      for (const { checkpoint, record } of request.checkpoints) {
        const write = value(
          await storage.beginWrite({
            ...metadata,
            target: { mode: "replace", id: record.id, expectedRevision: record.revision },
            checkpoint: { handle: checkpoint, phase: "final" },
            drainToken: request.token,
          }),
        );
        value(
          await storage.writeChunk({
            write: write.write,
            offset: 0,
            data: bytes.toString("base64"),
          }),
        );
        value(await storage.sealWrite({ write: write.write }));
        value(await storage.commitWrite({ write: write.write, drainToken: request.token }));
        writes.push(write.write);
      }
      return { ok: true, value: { status: "submitted", writes } };
    },
  }),
).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
