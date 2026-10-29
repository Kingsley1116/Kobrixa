import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definePlugin, runPlugin } from "@kobrixa/plugin-sdk";
const value = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw Error("public RPC failed");
  return r.value;
};
void runPlugin(
  definePlugin({
    activate(ctx) {
      console.error(`IMPORT_BOOT:${JSON.stringify({ pid: process.pid, pluginId: ctx.pluginId })}`);
      let next = 0;
      ctx.commands.register("test.synthetic.inspect", async () => {
        const page = value(await ctx.storage.list({ kind: "test.synthetic", limit: 64 }));
        assert.equal(page.nextCursor, undefined);
        const record = page.entries.slice().sort((a, b) => a.id.localeCompare(b.id))[next++];
        assert.ok(record);
        {
          const opened = value(
            await ctx.storage.openRead({
              id: record.id,
              expectedRevision: record.revision,
              schemaVersion: 1,
            }),
          );
          const hash = createHash("sha256");
          let offset = 0;
          try {
            for (;;) {
              const chunk = value(
                await ctx.storage.readChunk({ read: opened.read, offset, maxBytes: 262144 }),
              );
              const bytes = Buffer.from(chunk.data, "base64");
              assert.ok(bytes.length > 0);
              hash.update(bytes);
              offset += bytes.length;
              if (chunk.eof) break;
            }
          } finally {
            value(await ctx.storage.closeRead({ read: opened.read }));
          }
          assert.equal(offset, record.byteLength);
          assert.equal(hash.digest("hex"), record.sha256);
        }
      });
      ctx.commands.register("test.synthetic.delete-first", async () => {
        const page = value(await ctx.storage.list({ kind: "test.synthetic", limit: 64 }));
        const record = page.entries.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
        assert.ok(record);
        value(await ctx.storage.delete({ id: record.id, expectedRevision: record.revision }));
      });
    },
  }),
);
