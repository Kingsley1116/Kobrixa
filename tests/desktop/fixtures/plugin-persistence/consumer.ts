import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definePlugin, runPlugin, type PluginContext } from "@kobrixa/plugin-sdk";
import { installSealedTtlConsumer } from "./sealed-ttl-consumer.js";
let ttlDrain: ReturnType<typeof installSealedTtlConsumer> | undefined;
const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture business failure");
  return result.value;
};
let actionCheckpointOnly = false;
void runPlugin(
  definePlugin({
    activate(ctx) {
      if (ctx.pluginId === "acceptance.ui-recording") ttlDrain = installSealedTtlConsumer(ctx);
      // Explicit T7 commands use this process's original public SDK channel.
      // Keep the original write handle across the lost-confirmation boundary.
      if (ctx.pluginId === "acceptance.ui-recording")
        ctx.commands.register(`${ctx.pluginId}.action-checkpoint-only`, async () => {
          actionCheckpointOnly = true;
        });
      if (ctx.pluginId === "acceptance.ui-recording")
        ctx.commands.register(`${ctx.pluginId}.renderer-seed`, async () => {
          const bytes = Buffer.from("Renderer loss unfinished write sentinel\n");
          const write = value(
            await ctx.storage.beginWrite({
              target: { mode: "create" },
              kind: "test.renderer-loss",
              schemaVersion: 1,
              label: "Renderer loss",
              mediaType: "application/octet-stream",
              byteLength: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            }),
          );
          value(
            await ctx.storage.writeChunk({
              write: write.write,
              offset: 0,
              data: bytes.toString("base64"),
            }),
          );
        });
      let actionJob: string | undefined;
      const actionBytes = Buffer.from("T7 action export value sentinel\n");
      if (ctx.pluginId.startsWith("acceptance.ui-"))
        for (const step of ["chunk", "commit"] as const)
          ctx.commands.register(`${ctx.pluginId}.action-${step}`, async () => {
            assert.ok(actionJob);
            if (step === "chunk")
              value(
                await ctx.actions.exportChunk({
                  export: actionJob,
                  offset: 0,
                  data: actionBytes.toString("base64"),
                }),
              );
            else await ctx.actions.exportCommit({ export: actionJob });
          });
      let unknownWrite: string | undefined;
      let unknownStep = 0;
      const unknownBytes = (next: boolean) =>
        Buffer.from(
          next ? "T7 complete replacement payload\n" : "T7 complete predecessor payload\n",
        );
      const unknownInput = (next: boolean) => ({
        kind: "test.unknown-publication",
        schemaVersion: 1,
        label: "Unknown publication",
        mediaType: "application/octet-stream" as const,
        byteLength: unknownBytes(next).length,
        sha256: createHash("sha256").update(unknownBytes(next)).digest("hex"),
      });
      if (ctx.pluginId.startsWith("acceptance.ui-"))
        for (const step of ["seed", "publish", "probe", "reconcile"] as const)
          ctx.commands.register(`${ctx.pluginId}.unknown-${step}`, async () => {
            assert.equal(["seed", "publish", "probe", "reconcile"][unknownStep++], step);
            if (step === "seed") {
              const stage = async (
                next: boolean,
                target: Parameters<typeof ctx.storage.beginWrite>[0]["target"],
              ) => {
                const write = value(
                  await ctx.storage.beginWrite({ ...unknownInput(next), target }),
                );
                value(
                  await ctx.storage.writeChunk({
                    write: write.write,
                    offset: 0,
                    data: unknownBytes(next).toString("base64"),
                  }),
                );
                value(await ctx.storage.sealWrite({ write: write.write }));
                return write;
              };
              const old = await stage(false, { mode: "create" });
              const saved = value(await ctx.storage.commitWrite({ write: old.write }));
              unknownWrite = (
                await stage(true, {
                  mode: "replace",
                  id: saved.record.id,
                  expectedRevision: saved.record.revision,
                })
              ).write;
            } else if (step === "publish") {
              assert.ok(unknownWrite);
              const result = await ctx.storage.commitWrite({ write: unknownWrite });
              assert.equal(result.ok, false);
              if (!result.ok) assert.equal(result.error.code, "PLUGIN_E_STORAGE_IO");
            } else if (step === "probe") {
              const result = await ctx.storage.beginWrite({
                ...unknownInput(true),
                target: { mode: "create" },
              });
              // Always clean an accidentally admitted write before reporting failure.
              if (result.ok) value(await ctx.storage.abortWrite({ write: result.value.write }));
              assert.equal(result.ok, false);
            } else {
              assert.ok(unknownWrite);
              const saved = value(await ctx.storage.commitWrite({ write: unknownWrite }));
              assert.deepEqual(
                value(await ctx.storage.commitWrite({ write: unknownWrite })),
                saved,
              );
            }
          });
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
        ctx.commands.registerContext(`${ctx.pluginId}.activate`, args, async (invocation) => {
          if (invocation.arguments.speed === -90 || invocation.arguments.speed === -91) {
            const actionRef = invocation.context.actionRef;
            assert.ok(actionRef, "Actual trusted UI dispatch must mint the action");
            if (invocation.arguments.speed === -91) {
              actionJob = value(
                await ctx.actions.exportBegin({
                  actionRef,
                  suggestedName: "action.txt",
                  mediaType: "text/plain",
                  byteLength: actionBytes.length,
                  sha256: createHash("sha256").update(actionBytes).digest("hex"),
                }),
              ).export;
            }
            return {
              output: { "action-ref": actionRef, ...(actionJob ? { export: actionJob } : {}) },
              fieldErrors: [],
            };
          }
          return {
            output: { speed: invocation.arguments.speed!, mode: invocation.arguments.mode! },
            fieldErrors: [],
          };
        });
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
    async drain(context) {
      const { request, storage } = context;
      const ttl = await ttlDrain?.(context);
      if (ttl) return ttl;
      if (actionCheckpointOnly) {
        actionCheckpointOnly = false;
        // Preserve the actual committed checkpoint for a core recovery export.
        return { ok: true, value: { status: "checkpoint-only", writes: [] } };
      }
      const writes: string[] = [];
      for (const { checkpoint, record } of request.checkpoints) {
        assert.equal(record.kind, "test.registration-end");
        const held = request.writes.filter((write) => write.id === record.id);
        if (held.length) {
          // The disconnect case staged the actual final payload before dispatch.
          // Commit exactly that host-held write through the public SDK.
          assert.equal(held.length, 1);
          assert.equal(held[0]!.state, "sealed");
          const committed = await storage.commitWrite({
            write: held[0]!.write,
            drainToken: request.token,
          });
          if (committed.ok) writes.push(held[0]!.write);
          // One injected I/O failure must not suppress another target's final.
          else {
            assert.equal(committed.error.code, "PLUGIN_E_STORAGE_IO");
            // A worker exception after dispatch is conservatively uncertain.
            // Query the original write through the SDK before host recovery
            // classifies its retained bytes; do not re-submit publication.
            const status = value(await storage.writeStatus({ write: held[0]!.write }));
            assert.equal(status.state, "sealed");
          }
          continue;
        }
        const bytes = Buffer.from(`Synthetic final checkpoint ${record.id}\n`);
        const write = value(
          await storage.beginWrite({
            target: { mode: "replace", id: record.id, expectedRevision: record.revision },
            kind: record.kind,
            schemaVersion: record.schemaVersion,
            label: record.label,
            mediaType: record.mediaType,
            byteLength: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
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
      const flushed = await storage.flush({});
      if (!flushed.ok && request.writes.length) {
        // Another original final may still be held or retryable. The host's
        // aggregate drain report, rather than this callback, decides saved.
        assert.equal(flushed.error.code, "PLUGIN_E_STORAGE_CONFLICT");
      } else value(flushed);
      return { ok: true, value: { status: "submitted", writes } };
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
