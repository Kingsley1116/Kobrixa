import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import {
  LabExport,
  prepareCsv,
  copyCalibrationCode,
} from "../../../../../plugins/sensor-lab/src/export-actions.js";
import { recording } from "./data.test.js";
const ok = <T>(value: T) => ({ ok: true as const, value });
function fixture() {
  const actions = {
    exportBegin: vi.fn(async (_input: { actionRef: string }) =>
      ok({ export: "original-export", state: "waiting" as const, expiresAt: Date.now() + 120000 }),
    ),
    exportStatus: vi.fn(async () =>
      ok({ state: "receiving", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
    ),
    exportChunk: vi.fn(async (p: { offset: number; data: string }) =>
      ok({
        receivedBytes: p.offset + Buffer.from(p.data, "base64").length,
        expiresAt: Date.now() + 120000,
      }),
    ),
    exportCommit: vi.fn(async () =>
      ok({ exported: true as const, commitId: "receipt", durability: "file-sync-only" as const }),
    ),
    exportCancel: vi.fn(async () => ok({ disposition: "aborted" as const })),
    copyText: vi.fn(async () => ok({ copied: true as const })),
  };
  const client = actions as unknown as PluginContext["actions"];
  return { actions, client, exporter: new LabExport(client) };
}
it("exports complete original rows, or only an explicit interval, without changing metadata", () => {
  const r = recording();
  r.frames.push({ ...r.frames[0]!, elapsedMs: 20, sessionElapsedMs: 20, sampledAt: 20 });
  r.frameCount = 2;
  r.durationMs = 20;
  const full = prepareCsv(r),
    slice = prepareCsv(r, { startMs: 20, endMs: 20 });
  expect(full.bytes.toString().split("\r\n")).toHaveLength(6);
  expect(slice.bytes.toString().split("\r\n")).toHaveLength(4);
  expect(full.sha256).toBe(createHash("sha256").update(full.bytes).digest("hex"));
  expect(r.frames).toHaveLength(2);
  expect(() => prepareCsv(r, { startMs: 21, endMs: 22 })).toThrow("interval");
});
it("requires explicit segmentation rather than truncating a large CSV", () => {
  const r = structuredClone(recording());
  r.name = "n".repeat(160);
  r.channels = Array.from({ length: 4 }, (_, i) => {
    const channel = structuredClone(r.channels[0]!);
    if (channel.source.origin !== "public") throw new Error("public fixture required");
    channel.source.channel.channelId = `channel-${i}`;
    channel.source.channel.name = "感".repeat(80);
    channel.source.channel.modeName = "測".repeat(80);
    return channel;
  });
  r.frames = Array.from({ length: 3600 }, (_, i) => ({
    ...r.frames[0]!,
    elapsedMs: i,
    sessionElapsedMs: i,
    sampledAt: i,
    values: [1, 2, 3, 4],
  }));
  r.frameCount = 3600;
  r.durationMs = 3600;
  expect(() => prepareCsv(r)).toThrow("explicit smaller time interval");
  expect(prepareCsv(r, { startMs: 0, endMs: 0 }).bytes.length).toBeLessThan(8388608);
});
it("consumes one fresh action and snapshots bytes before background upload", async () => {
  const f = fixture(),
    csv = prepareCsv(recording()),
    original = Buffer.from(csv.bytes);
  const started = f.exporter.start("fresh-gesture", csv);
  csv.bytes.fill(0);
  await started;
  await f.exporter.completion;
  expect(f.actions.exportBegin).toHaveBeenCalledTimes(1);
  expect(f.actions.exportBegin.mock.calls[0]![0]).toMatchObject({
    actionRef: "fresh-gesture",
    mediaType: "text/csv",
  });
  expect(Buffer.from(f.actions.exportChunk.mock.calls[0]![0].data, "base64")).toEqual(original);
  expect(f.exporter.state.phase).toBe("completed");
});
it("waits for native choice without borrowing the invocation abort signal", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.actions.exportStatus.mockResolvedValueOnce(
      ok({ state: "waiting", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
    );
    const command = new AbortController();
    await f.exporter.start("fresh", prepareCsv(recording()), command.signal);
    command.abort();
    expect(f.exporter.state.phase).toBe("waiting");
    expect(f.actions.exportChunk).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await f.exporter.completion;
    expect(f.exporter.state.phase).toBe("completed");
  } finally {
    vi.useRealTimers();
  }
});
it("lost commit reply reconciles original job without replaying begin or commit", async () => {
  const f = fixture();
  f.actions.exportCommit.mockRejectedValueOnce(new Error("lost"));
  f.actions.exportStatus.mockResolvedValueOnce(
    ok({ state: "receiving", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
  );
  f.actions.exportStatus.mockResolvedValueOnce(
    ok({
      state: "completed",
      receivedBytes: 0,
      expiresAt: Date.now() + 120000,
      commitId: "receipt",
      durability: "file-sync-only",
    }),
  );
  await f.exporter.start("fresh", prepareCsv(recording()));
  await f.exporter.completion;
  expect(f.exporter.state.phase).toBe("completed");
  expect(f.actions.exportCommit).toHaveBeenCalledTimes(1);
  expect(f.actions.exportBegin).toHaveBeenCalledTimes(1);
});
it("unknown admission fences a new export and clipboard errors never report success", async () => {
  const f = fixture();
  f.actions.exportBegin.mockRejectedValueOnce(new Error("lost"));
  await expect(f.exporter.start("fresh", prepareCsv(recording()))).rejects.toThrow("lost");
  await expect(f.exporter.start("another", prepareCsv(recording()))).rejects.toThrow("unresolved");
  expect(f.actions.exportBegin).toHaveBeenCalledTimes(1);
  f.actions.copyText.mockRejectedValueOnce(new Error("permission"));
  await expect(copyCalibrationCode(f.client, "copy-gesture", "code")).rejects.toThrow("permission");
  expect(f.actions.copyText).toHaveBeenCalledTimes(1);
});
it("native cancellation does not upload or falsely complete", async () => {
  const f = fixture();
  f.actions.exportStatus.mockResolvedValueOnce(
    ok({ state: "cancelled", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
  );
  await f.exporter.start("fresh", prepareCsv(recording()));
  await f.exporter.completion;
  expect(f.exporter.state.phase).toBe("cancelled");
  expect(f.actions.exportChunk).not.toHaveBeenCalled();
  expect(f.actions.exportCommit).not.toHaveBeenCalled();
});

import type { ResourceOwner, PersistenceActionRequestMap } from "@kobrixa/plugin-protocol";
import {
  createPersistenceActions,
  type ActionDependencies,
  type ExportDestination,
} from "../../main/plugins/persistence/actions.js";
const owner: ResourceOwner = {
  sourceKey: "builtin:test.actions",
  pluginId: "test.actions",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const p = { kind: "plugin" as const, owner, authorityContext: null };
const actionRef = "00000000-0000-4000-8000-000000000003";
function actionFixture() {
  let now = 0,
    alive = true,
    used = false;
  let choose!: (value: ExportDestination | null) => void;
  const copyText = vi.fn(async () => {}),
    begin = vi.fn(async () => {});
  const deps: ActionDependencies = {
    now: () => now,
    wall: () => 100000 + now,
    live: () => alive,
    permission: () => true,
    actions: {
      claim: (context) => {
        if (
          context.actionRef !== actionRef ||
          context.owner.generation !== 1 ||
          now >= 5000 ||
          used
        )
          return {
            ok: false,
            error: {
              code: "PLUGIN_E_PERMISSION_DENIED",
              message: "User action required.",
              detail: { kind: "permission", reason: "user-action-required" },
            },
          };
        used = true;
        return { ok: true, value: { action: actionRef } };
      },
    },
    adapter: {
      copyText,
      chooseDestination: () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    },
    destinations: {
      register: async () => {
        throw new Error("Native registration is exercised by the worker test.");
      },
      release: vi.fn(async () => {}),
    },
    output: {
      begin,
      append: async (_id, _offset, data) => data.length,
      commit: async () => ({
        disposition: "committed",
        commitId: actionRef,
        durability: "file-sync-only",
      }),
      reconcile: async () => ({ disposition: "unknown" }),
      abort: async () => "aborted",
    },
  };
  return {
    service: createPersistenceActions(deps),
    deps,
    copyText,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
    die: () => {
      alive = false;
    },
    choose: (value: ExportDestination | null) => choose(value),
  };
}

import { createPersistenceActionsClient } from "../../../../../packages/plugin-sdk-js/src/persistence-actions.js";

it("actual action service: reconcile original publishing job without replay, then permit a fresh gesture", async () => {
  const f = actionFixture();
  f.deps.wall = () => Date.now();
  f.deps.adapter.chooseDestination = async () => Object.freeze({}) as ExportDestination;
  f.deps.output.commit = vi.fn<ActionDependencies["output"]["commit"]>(async () => ({
    disposition: "unknown",
  }));
  f.deps.output.reconcile = vi
    .fn<ActionDependencies["output"]["reconcile"]>()
    .mockResolvedValueOnce({ disposition: "unknown" })
    .mockResolvedValue({
      disposition: "committed",
      commitId: actionRef,
      durability: "file-sync-only",
    });
  let job = "",
    begins = 0;
  const statusJobs: string[] = [];
  const client = createPersistenceActionsClient(async (method, params, options) => {
    if (method === "storage/exportStatus") statusJobs.push((params as { export: string }).export);
    switch (method) {
      case "storage/exportBegin":
      case "storage/exportChunk":
      case "storage/exportCommit":
      case "storage/exportStatus":
      case "storage/exportCancel":
      case "ui/copyText":
        break;
      default:
        throw new Error("Action method required");
    }
    const result = await f.service.request(
      p,
      method,
      params as PersistenceActionRequestMap[keyof PersistenceActionRequestMap]["params"],
      options.signal ?? new AbortController().signal,
    );
    if (method === "storage/exportBegin" && result.ok) {
      job = (result.value as { export: string }).export;
      begins++;
    }
    return result as never;
  });
  const exporter = new LabExport(client),
    csv = prepareCsv(recording());
  await exporter.start(actionRef, csv);
  await exporter.completion;
  expect(exporter.state.phase).toBe("unknown");
  await expect(exporter.reconcile()).resolves.toMatchObject({ phase: "completed" });
  expect(new Set(statusJobs)).toEqual(new Set([job]));
  expect(begins).toBe(1);
  expect(f.deps.output.commit).toHaveBeenCalledTimes(1);
  // The helper permits a new explicit gesture; the host still refuses reused authority.
  await expect(exporter.start(actionRef, csv)).rejects.toThrow("User action required");
  expect(begins).toBe(1);
  exporter.dispose();
});

async function unresolvedExport() {
  const f = fixture();
  f.actions.exportCommit.mockRejectedValueOnce(new Error("lost commit"));
  f.actions.exportStatus.mockResolvedValueOnce(
    ok({ state: "receiving", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
  );
  f.actions.exportStatus.mockResolvedValue(
    ok({ state: "publishing", receivedBytes: 0, expiresAt: Date.now() + 120000 }),
  );
  await f.exporter.start("fresh", prepareCsv(recording()));
  await f.exporter.completion;
  expect(f.exporter.state.phase).toBe("unknown");
  return f;
}
it("reconcile preserves unknown on publishing, failed query or missing completion receipt", async () => {
  const f = await unresolvedExport();
  expect((await f.exporter.reconcile()).phase).toBe("unknown");
  f.actions.exportStatus.mockRejectedValueOnce(new Error("status unavailable"));
  await expect(f.exporter.reconcile()).rejects.toThrow("status unavailable");
  f.actions.exportStatus.mockResolvedValueOnce(
    ok({ state: "completed", receivedBytes: 0, expiresAt: 0 }),
  );
  await expect(f.exporter.reconcile()).rejects.toThrow("not confirmed");
  expect(f.exporter.state.phase).toBe("unknown");
  await expect(f.exporter.start("fresh-again", prepareCsv(recording()))).rejects.toThrow(
    "unresolved",
  );
  expect(f.actions.exportBegin).toHaveBeenCalledTimes(1);
  expect(f.actions.exportCommit).toHaveBeenCalledTimes(1);
  expect(f.actions.exportCancel).not.toHaveBeenCalled();
  f.exporter.dispose();
});
it("unknown admission has no job to query and never guesses a handle", async () => {
  const f = fixture();
  f.actions.exportBegin.mockRejectedValueOnce(new Error("lost"));
  await expect(f.exporter.start("fresh", prepareCsv(recording()))).rejects.toThrow();
  await expect(f.exporter.reconcile()).rejects.toThrow("admission outcome unknown");
  expect(f.actions.exportStatus).not.toHaveBeenCalled();
});
it("reconcile serializes requests and ignores completion after disposal", async () => {
  const f = await unresolvedExport();
  let finish!: (value: Awaited<ReturnType<typeof f.client.exportStatus>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof f.client.exportStatus>>>((resolve) => {
    finish = resolve;
  });
  // Use the public client shape for an intentionally delayed receipt.
  f.actions.exportStatus.mockImplementationOnce(
    () => pending as ReturnType<typeof f.actions.exportStatus>,
  );
  const request = f.exporter.reconcile();
  await expect(f.exporter.reconcile()).rejects.toThrow("active");
  f.exporter.dispose();
  finish(
    ok({
      state: "completed",
      receivedBytes: 0,
      expiresAt: 0,
      commitId: actionRef,
      durability: "file-sync-only",
    }),
  );
  await request;
  expect(f.exporter.state.phase).toBe("unknown");
  await expect(f.exporter.reconcile()).rejects.toThrow("disposed");
});
it("confirmed terminal non-publication clears the original job without reporting completion", async () => {
  for (const state of ["cancelled", "expired", "failed"] as const) {
    const f = await unresolvedExport();
    f.actions.exportStatus.mockResolvedValueOnce(ok({ state, receivedBytes: 0, expiresAt: 0 }));
    expect((await f.exporter.reconcile()).phase).toBe(
      state === "cancelled" ? "cancelled" : "error",
    );
    expect(f.actions.exportBegin).toHaveBeenCalledTimes(1);
    f.exporter.dispose();
  }
});
