import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { basicPlusLanguageService } from "./basic-plus-service.js";
import {
  startCompletionWorker,
  type CompletionWorkerRequest,
  type CompletionWorkerReply,
} from "./completion-worker.js";

it("creates one completion provider per new epoch, retains deltas, and recreates on a full resync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-completion-worker-"));
  const { port1, port2 } = new MessageChannel();
  const disposals: ReturnType<typeof vi.spyOn>[] = [];
  const createCompletion = vi.fn(() => {
    const provider = basicPlusLanguageService.createCompletion();
    disposals.push(vi.spyOn(provider, "dispose"));
    return provider;
  });
  startCompletionWorker(port1, {
    "kobrixa.basic-plus:bp": { ...basicPlusLanguageService, createCompletion },
  });
  let id = 0;
  const send = async (epoch: number, revision: number, baseRevision: number | null) => {
    const reply = once(port2, "message");
    port2.postMessage({
      id: ++id,
      workspaceId: "w",
      input: { inputPath: root, selectedEntry: "main.bp" },
      cancellation: new SharedArrayBuffer(4),
      binding: {
        epoch,
        pluginId: "kobrixa.basic-plus",
        sourceKey: "builtin:kobrixa.basic-plus",
        language: "bp",
        extensions: ["bp", "bpi", "bpm"],
        capabilities: ["analysis", "completion"],
        frontend: {
          language: "bp",
          entryExtensions: ["bp"],
          sourceExtensions: ["bp", "bpi", "bpm"],
          ir: { min: 1, max: 1 },
        },
      },
      request: { epoch, session: "s", revision, baseRevision, refresh: false, updates: [] },
    } satisfies CompletionWorkerRequest);
    return (await reply)[0] as CompletionWorkerReply;
  };
  try {
    await writeFile(path.join(root, "main.bp"), "value = 1\n");
    expect(await send(1, 1, null)).toMatchObject({ ok: true, reply: { kind: "result" } });
    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(disposals[0]).not.toHaveBeenCalled();
    expect(await send(1, 2, 1)).toMatchObject({ ok: true, reply: { kind: "result" } });
    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(await send(1, 3, null)).toMatchObject({ ok: true, reply: { kind: "result" } });
    expect(createCompletion).toHaveBeenCalledTimes(2);
    expect(disposals[0]).toHaveBeenCalledOnce();
    expect(await send(2, 1, null)).toMatchObject({ ok: true, reply: { kind: "result", epoch: 2 } });
    expect(createCompletion).toHaveBeenCalledTimes(3);
    expect(disposals[1]).toHaveBeenCalledOnce();
    expect(disposals[2]).not.toHaveBeenCalled();
    expect(await send(1, 4, null)).toMatchObject({ ok: true, reply: { kind: "resync", epoch: 2 } });
    expect(createCompletion).toHaveBeenCalledTimes(3);
  } finally {
    const closed = once(port1, "close");
    port2.close();
    port1.close();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
