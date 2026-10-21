import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definePlugin, runPlugin, type PluginContext } from "@kobrixa/plugin-sdk";
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture business failure");
  return result.value;
};
void runPlugin(
  definePlugin({
    activate(ctx) {
      // One public SDK context for both the packaged UI v1 and persistence fixture.
      if (ctx.pluginId.startsWith("acceptance.ui-")) {
        ctx.commands.register(`${ctx.pluginId}.legacy`, async () => {});
        const args = {
          speed: {
            type: "number" as const,
            min: -100,
            max: 100,
            integer: true,
            nullable: false as const,
          },
          mode: { type: "enum" as const, values: ["coast", "brake"], nullable: false as const },
        };
        ctx.commands.registerContext(`${ctx.pluginId}.activate`, args, async (invocation) => ({
          output: { speed: invocation.arguments.speed!, mode: invocation.arguments.mode! },
          fieldErrors: [],
        }));
        ctx.commands.registerContext(`${ctx.pluginId}.hold`, args, async (invocation) => ({
          output: {
            speed: invocation.arguments.speed!,
            mode: invocation.arguments.mode!,
            phase:
              invocation.context.trigger.kind === "hold"
                ? invocation.context.trigger.phase
                : "invalid",
          },
          fieldErrors: [],
        }));
      }
      ctx.commands.register(`${ctx.pluginId}.run`, async () => {
        const initial = value(await ctx.settings.read({ schemaVersion: 1 }));
        const watch = value(await ctx.settings.watch({ schemaVersion: 1 }));
        const updated = value(
          await ctx.settings.update({
            schemaVersion: 1,
            expectedRevision: initial.revision,
            changes: [{ key: "fixture.enabled", value: true }],
          }),
        );
        const conflict = await ctx.settings.update({
          schemaVersion: 1,
          expectedRevision: initial.revision,
          changes: [{ key: "fixture.enabled", value: false }],
        });
        assert.equal(conflict.ok, false);
        if (!conflict.ok) assert.equal(conflict.error.code, "PLUGIN_E_SETTINGS_CONFLICT");
        assert.notEqual(updated.snapshot.revision, initial.revision);
        const reread = value(await ctx.settings.read({ schemaVersion: 1 }));
        assert.equal(reread.revision, updated.snapshot.revision);
        // The public event/router trace must separately prove invalidation delivery/ACK.
        // This read alone is not watch callback evidence.
        const bytes = Buffer.alloc(262144, 0x61);
        const digest = createHash("sha256").update(bytes).digest("hex");
        const write = value(
          await ctx.storage.beginWrite({
            target: { mode: "create" },
            kind: "test.fixture",
            schemaVersion: 1,
            label: "Synthetic record",
            mediaType: "application/octet-stream",
            byteLength: bytes.length,
            sha256: digest,
          }),
        );
        value(
          await ctx.storage.writeChunk({
            write: write.write,
            offset: 0,
            data: bytes.toString("base64"),
          }),
        );
        value(await ctx.storage.sealWrite({ write: write.write }));
        const committed = value(await ctx.storage.commitWrite({ write: write.write }));
        const duplicate = value(await ctx.storage.commitWrite({ write: write.write }));
        assert.deepEqual(duplicate.receipt, committed.receipt);
        const list = value(await ctx.storage.list({ kind: "test.fixture", limit: 1 }));
        assert.equal(list.entries.length, 1);
        const read = value(
          await ctx.storage.openRead({
            id: committed.record.id,
            expectedRevision: committed.record.revision,
            schemaVersion: 1,
          }),
        );
        const chunk = value(
          await ctx.storage.readChunk({ read: read.read, offset: 0, maxBytes: 262144 }),
        );
        assert.equal(
          createHash("sha256").update(Buffer.from(chunk.data, "base64")).digest("hex"),
          digest,
        );
        assert.equal(chunk.eof, true);
        value(await ctx.storage.closeRead({ read: read.read }));
        value(await ctx.storage.flush({}));
        assert.equal(
          value(await ctx.settings.unwatch({ subscriptionId: watch.subscriptionId })).removed,
          true,
        );
        assert.equal(
          value(await ctx.settings.unwatch({ subscriptionId: watch.subscriptionId })).removed,
          false,
        );
      });
    },
    async drain({ request, storage }) {
      assert.equal(request.checkpoints.length, 0);
      value(await storage.flush({}));
      return { ok: true, value: { status: "submitted", writes: [] } };
    },
  }),
).catch(() => {
  process.exitCode = 1;
});

// Called only with the SDK's actual invocation-bound context after a fresh user action.
// The controller must supply real action/route traces before counting either operation.
export async function exportFixture(ctx: PluginContext) {
  const actionRef = ctx.actions.actionRef;
  assert.ok(actionRef, "Export requires a fresh host action");
  const bytes = Buffer.from("Synthetic persistence export\n");
  const job = value(
    await ctx.actions.exportBegin({
      actionRef,
      suggestedName: "fixture.txt",
      mediaType: "text/plain",
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  const deadline = performance.now() + 10000;
  for (;;) {
    const status = value(await ctx.actions.exportStatus({ export: job.export }));
    if (status.state === "cancelled") return { cancelled: true };
    if (status.state === "receiving") break;
    assert.equal(status.state, "waiting");
    assert.ok(
      performance.now() < deadline,
      "Dialog observation deadline exceeded; no automatic mutation retry",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  value(
    await ctx.actions.exportChunk({
      export: job.export,
      offset: 0,
      data: bytes.toString("base64"),
    }),
  );
  return value(await ctx.actions.exportCommit({ export: job.export }));
}
export async function copyFixture(ctx: PluginContext) {
  const actionRef = ctx.actions.actionRef;
  assert.ok(actionRef, "Copy requires its own fresh action");
  return value(await ctx.ui.copyText({ actionRef, text: "Synthetic persistence fixture" }));
}
