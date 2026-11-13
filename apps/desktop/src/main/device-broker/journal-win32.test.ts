import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createWin32JournalAdapter,
  createWin32JournalWorker,
  executeWin32JournalWorker,
  invokeWin32JournalAddon,
  journalWin32AddonPath,
} from "./journal-win32.js";

const location = { packaged: true, resourcesPath: "/installed/resources", appPath: "/checkout" };
const receipt = { supported: true, published: true, fileFlushed: true, directoryFlushed: true };
function fakeAddon() {
  return {
    apiVersion: "1",
    napiVersion: "8",
    arch: "x64",
    capabilities: vi.fn(() => ({ supported: true })),
    initializeDirectory: vi.fn(() => ({ supported: true, flushed: true })),
    syncDirectory: vi.fn(() => ({ supported: true, flushed: true })),
    durableReplace: vi.fn(() => receipt),
  };
}
afterEach(() => vi.useRealTimers());
it("selects one packaged unpacked path and a separate development path", () => {
  expect(journalWin32AddonPath(location)).toBe(
    path.join(location.resourcesPath, "app.asar.unpacked/native/journal-win32/journal_win32.node"),
  );
  expect(journalWin32AddonPath({ ...location, packaged: false })).toBe(
    path.join(location.appPath, "native/journal-win32/build/Release/journal_win32.node"),
  );
});
it.each([
  ["MODULE_NOT_FOUND", "addon-missing"],
  ["ERR_DLOPEN_FAILED", "addon-load-failed-abi-or-arch"],
])("distinguishes %s and never falls back", async (code, diagnostic) => {
  const load = vi.fn(() => {
    throw Object.assign(new Error("native load failed"), { code });
  });
  await expect(
    invokeWin32JournalAddon(load, "syncDirectory", ["root"], "x64", 8),
  ).rejects.toMatchObject({ code: "ENOTSUP", diagnostic });
  expect(load).toHaveBeenCalledTimes(1);
});
it.each([{ apiVersion: "2" }, { napiVersion: "9" }, { arch: "arm64" }, { capabilities: null }])(
  "refuses incompatible addon metadata %j",
  async (change) => {
    const addon = { ...fakeAddon(), ...change };
    await expect(
      invokeWin32JournalAddon(() => addon, "syncDirectory", ["root"], "x64", 8),
    ).rejects.toMatchObject({ code: "ENOTSUP", diagnostic: "addon-incompatible-api-abi-or-arch" });
    expect(addon.syncDirectory).not.toHaveBeenCalled();
  },
);
it("refuses insufficient runtime N-API", async () => {
  await expect(
    invokeWin32JournalAddon(fakeAddon, "syncDirectory", ["root"], "x64", 7),
  ).rejects.toMatchObject({ code: "ENOTSUP" });
});
it("unsupported volume never reaches a mutation", async () => {
  const addon = fakeAddon();
  addon.capabilities.mockReturnValue({ supported: false });
  await expect(
    invokeWin32JournalAddon(() => addon, "durableReplace", ["root"], "x64", 8),
  ).rejects.toMatchObject({ code: "ENOTSUP", diagnostic: "unsupported-volume" });
  expect(addon.durableReplace).not.toHaveBeenCalled();
});
it.each([
  "validate",
  "create-temp",
  "write-temp",
  "flush-temp",
  "pre-publication",
  "move",
  "flush-published",
  "flush-directory",
])("preserves native failure and uncertainty at %s", async (phase) => {
  const addon = fakeAddon();
  const failure = Object.assign(new Error("native failure"), {
    code: "EIO",
    phase,
    win32Code: 1117,
    publicationState: "uncertain",
  });
  addon.durableReplace.mockImplementation(() => {
    throw failure;
  });
  await expect(
    invokeWin32JournalAddon(
      () => addon,
      "durableReplace",
      ["root", "faults.json", "temp", new Uint8Array([1])],
      "x64",
      8,
    ),
  ).rejects.toBe(failure);
});
it("validates actual success receipts and converts cloned bytes to Buffer", async () => {
  const addon = fakeAddon();
  await invokeWin32JournalAddon(() => addon, "syncDirectory", ["root"], "x64", 8);
  await invokeWin32JournalAddon(
    () => addon,
    "durableReplace",
    ["root", "faults.json", "temp", new Uint8Array([1, 2])],
    "x64",
    8,
  );
  expect(addon.durableReplace).toHaveBeenCalledWith(
    "root",
    "faults.json",
    "temp",
    Buffer.from([1, 2]),
  );
  addon.durableReplace.mockReturnValue({ ...receipt, directoryFlushed: false });
  await expect(
    invokeWin32JournalAddon(
      () => addon,
      "durableReplace",
      ["root", "faults.json", "temp", Buffer.from([1])],
      "x64",
      8,
    ),
  ).rejects.toMatchObject({
    code: "ENOTSUP",
    diagnostic: "invalid-native-receipt",
  });
});
it("runs the production worker bridge asynchronously using a fake addon", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-worker-"));
  try {
    const file = path.join(root, "fake.cjs");
    await writeFile(
      file,
      `module.exports = {
      apiVersion: '1', napiVersion: '8', arch: process.arch,
      capabilities: () => ({ supported: true }),
      syncDirectory: () => ({ supported: true, flushed: true }),
      durableReplace: (dir, target, temp, bytes) => {
        if (!Buffer.isBuffer(bytes)) throw new Error('not Buffer');
        return ${JSON.stringify(receipt)};
      }
    };`,
    );
    await executeWin32JournalWorker(file, "syncDirectory", [root]);
    await executeWin32JournalWorker(file, "durableReplace", [
      root,
      "faults.json",
      "temp",
      Buffer.from([1]),
    ]);
    await expect(
      executeWin32JournalWorker(path.join(root, "missing.node"), "syncDirectory", [root]),
    ).rejects.toMatchObject({ code: "ENOTSUP", diagnostic: "addon-missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("bounds the in-flight worker, rejects at five seconds and fences late completion", async () => {
  vi.useFakeTimers();
  let settle!: () => void;
  const execute = vi.fn<typeof executeWin32JournalWorker>(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const adapter = createWin32JournalAdapter({ location: async () => location, execute });
  const pending = adapter.syncDirectory("root");
  const failure = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
  await expect(adapter.syncDirectory("root")).rejects.toMatchObject({ code: "EBUSY" });
  await vi.advanceTimersByTimeAsync(5000);
  await failure;
  settle();
  await Promise.resolve();
  await expect(adapter.syncDirectory("root")).rejects.toMatchObject({ code: "EBUSY" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toBe(journalWin32AddonPath(location));
});
it("bounds payload before worker creation", async () => {
  const execute = vi.fn();
  const adapter = createWin32JournalAdapter({ execute });
  await expect(
    adapter.durableReplace("root", "faults.json", "temp", new Uint8Array(8388609)),
  ).rejects.toThrow("journal write budget");
  expect(execute).not.toHaveBeenCalled();
});

it("reuses one real worker and capability traversal, then disposes on app quit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "journal-worker-reuse-"));
  const file = path.join(root, "fake.cjs");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(
    file,
    `
    const { appendFileSync } = require('node:fs');
    const { threadId } = require('node:worker_threads');
    const record = (operation) => appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ operation, threadId }) + '\\n');
    module.exports = { apiVersion: '1', napiVersion: '8', arch: process.arch,
      capabilities: () => { record('capabilities'); return { supported: true }; },
      syncDirectory: () => { record('sync'); return { supported: true, flushed: true }; },
      durableReplace: () => { record('replace'); return ${JSON.stringify(receipt)}; }
    };`,
  );
  const factory = vi.fn(() => createWin32JournalWorker(file));
  let quit!: () => void;
  const removeListener = vi.fn();
  const adapter = createWin32JournalAdapter({
    location: async () => location,
    workerFactory: factory,
    onQuit: (dispose) => {
      quit = dispose;
      return removeListener;
    },
  });
  try {
    await adapter.syncDirectory(root);
    for (let i = 0; i < 3; i++)
      await adapter.durableReplace(root, "faults.json", "temp", Buffer.from([i]));
    const recorded = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { operation: string; threadId: number });
    expect(recorded.map((row) => row.operation)).toEqual([
      "capabilities",
      "sync",
      "replace",
      "replace",
      "replace",
    ]);
    expect(new Set(recorded.map((row) => row.threadId)).size).toBe(1);
    expect(factory).toHaveBeenCalledOnce();
    // A separate Node process must exit with an idle worker still allocated.
    // This uses Node's native TypeScript support and never imports Electron.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createWin32JournalWorker } from ${JSON.stringify(new URL("./journal-win32.ts", import.meta.url).href)};
      const worker = createWin32JournalWorker(${JSON.stringify(file)});
      await worker.execute("syncDirectory", [${JSON.stringify(root)}]);
    `,
      ],
      { timeout: 5000 },
    );
    quit();
    expect(removeListener).toHaveBeenCalledOnce();
    await expect(adapter.syncDirectory(root)).rejects.toMatchObject({ code: "EBUSY" });
  } finally {
    adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
it("disposal while loading prevents a late worker from being started", async () => {
  let release!: (value: typeof location) => void;
  const context = new Promise<typeof location>((resolve) => {
    release = resolve;
  });
  const workerFactory = vi.fn();
  const adapter = createWin32JournalAdapter({ location: () => context, workerFactory });
  const pending = adapter.syncDirectory("root");
  adapter.dispose();
  release(location);
  await expect(pending).rejects.toThrow("after fence");
  expect(workerFactory).not.toHaveBeenCalled();
});

it("initializes an absent directory before capability traversal and requires both flushes", async () => {
  const addon = fakeAddon();
  addon.capabilities.mockImplementation(() => {
    throw new Error("directory absent");
  });
  await invokeWin32JournalAddon(() => addon, "initializeDirectory", ["root"], "x64", 8);
  expect(addon.initializeDirectory).toHaveBeenCalledExactlyOnceWith("root");
  expect(addon.capabilities).not.toHaveBeenCalled();
  addon.initializeDirectory.mockReturnValue({ supported: true, flushed: false });
  await expect(
    invokeWin32JournalAddon(() => addon, "initializeDirectory", ["root"], "x64", 8),
  ).rejects.toMatchObject({ code: "ENOTSUP", diagnostic: "invalid-native-receipt" });
});
it("does not cache failed initialization or swallow unsafe pre-existing ACL diagnostics", async () => {
  const addon = fakeAddon();
  const failure = Object.assign(
    new Error("journal DACL permits another principal to mutate evidence"),
    { code: "EUNSAFE" },
  );
  addon.initializeDirectory.mockImplementation(() => {
    throw failure;
  });
  await expect(
    invokeWin32JournalAddon(() => addon, "initializeDirectory", ["root"], "x64", 8),
  ).rejects.toBe(failure);
  expect(addon.durableReplace).not.toHaveBeenCalled();
});
