import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createJournalFilesystem, writeAll } from "./journal-filesystem.js";
import { createWin32JournalAdapter, invokeWin32JournalAddon } from "./journal-win32.js";
import { createJournal, journalDocument } from "./journal.js";
import type { SafetyFaultEntry } from "@kobrixa/plugin-runtime";
import { createDeviceBroker } from "./broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "./fake-provider.js";
import { createCoreActionLedger } from "../plugins/core-recovery.js";
import { LifecycleCoordinator, createResourceFreePersistence } from "./lifecycle-coordinator.js";
import { requireCleanClose, ShutdownCoordinator } from "../plugins/shutdown-coordinator.js";
import { unavailableUi150 } from "@kobrixa/plugin-runtime";

// Exercise the real close/update gate with a fake transport and the failed journal.
async function expectCloseAndUpdateBlocked(journal: ReturnType<typeof createJournal>) {
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: "local",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: createCoreActionLedger({ now: h.dependencies.now, current: () => true }),
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  broker.registerProvider(h.provider);
  const connected = await broker.request(
    pluginPrincipal(),
    "devices/connect",
    { target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" } },
    new AbortController().signal,
  );
  expect(connected.ok).toBe(true);
  const persistence = createResourceFreePersistence(() => true);
  const shutdown = vi.fn(async () => {});
  const lifecycle = new LifecycleCoordinator({
    ports: { device: broker.resources, persistence, ui: unavailableUi150() },
    resources: broker.resources,
    sessions: broker.sessions,
    reservations: broker.reservations,
    recovery: broker.recovery,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [],
    now: h.dependencies.now,
    shutdown,
    legacyFlush: async () => {},
    report: () => {},
  });
  try {
    const coordinator = new ShutdownCoordinator(lifecycle);
    const outcomes = await Promise.allSettled(
      (["shutdown", "update"] as const).map((reason) => requireCleanClose(coordinator, reason)),
    );
    expect(outcomes.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(shutdown).not.toHaveBeenCalled();
  } finally {
    lifecycle.dispose();
  }
}

afterEach(() => vi.unstubAllGlobals());
it("F10 loops on short writes and rejects zero progress", async () => {
  const output: number[] = [];
  await writeAll(new Uint8Array([1, 2, 3]), async (bytes, offset) => {
    output.push(bytes[offset]!);
    return 1;
  });
  expect(output).toEqual([1, 2, 3]);
  await expect(writeAll(new Uint8Array([1]), async () => 0)).rejects.toThrow();
});
it("F10 uses exclusive same-directory temporary files and refuses symlink evidence", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    // Model the unavailable Windows directory barrier; retain real file operations.
    const fs = createJournalFilesystem(
      root,
      process.platform === "win32" ? async () => {} : undefined,
    );
    await fs.initialize();
    await fs.write("faults.next-00000000-0000-4000-8000-000000000001.json", Buffer.from("pending"));
    await fs.sync("faults.next-00000000-0000-4000-8000-000000000001.json");
    await fs.replace("faults.next-00000000-0000-4000-8000-000000000001.json", "faults.json");
    await fs.syncDirectory();
    expect(await readFile(path.join(root, "device-broker/faults.json"), "utf8")).toBe("pending");
    await writeFile(path.join(root, "outside"), "keep");
    await symlink(
      path.join(root, "outside"),
      path.join(root, "device-broker/faults.previous.json"),
    );
    await expect(fs.read("faults.previous.json")).rejects.toThrow();
    expect(await readFile(path.join(root, "outside"), "utf8")).toBe("keep");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it("F10 rejects a non-canonical symlinked root", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    // Model the unavailable Windows directory barrier; retain real file operations.
    const fs = createJournalFilesystem(
      root,
      process.platform === "win32" ? async () => {} : undefined,
    );
    await fs.initialize();
    const linkedRoot = path.join(root, "linked-root");
    await symlink(root, linkedRoot, "dir");
    expect(await realpath(linkedRoot)).toBe(root);
    await expect(
      createJournalFilesystem(
        linkedRoot,
        process.platform === "win32" ? async () => {} : undefined,
      ).initialize(),
    ).rejects.toThrow("journal directory");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("F10 Windows rejects an unsupported directory barrier and marks the journal unwritable", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-policy-"));
  try {
    const root = await realpath(temp);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const fs = createJournalFilesystem(root);
    await expect(fs.initialize()).rejects.toMatchObject({ code: "ENOTSUP" });
    await expect(fs.syncDirectory()).rejects.toMatchObject({ code: "ENOTSUP" });
    const journal = createJournal(fs, {
      hostEpoch: "00000000-0000-4000-8000-000000000001",
      assertHeld() {},
    });
    await journal.load();
    expect(journal.snapshot().journalHealth).toBe("unwritable");
    await expect(journal.commit(journalDocument(1, []))).rejects.toThrow("journal write blocked");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it.each(["EIO", "EPERM"])("F10 does not downgrade a %s directory barrier failure", async (code) => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-policy-"));
  try {
    const root = await realpath(temp);
    const fs = createJournalFilesystem(root, async () => {
      throw Object.assign(new Error("directory barrier failed"), { code });
    });
    await expect(fs.initialize()).rejects.toMatchObject({ code });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it.each(["root", "parent"])(
  "W02b failed %s barrier preserves real on-disk faults and denies mutations",
  async (point) => {
    const temp = await mkdtemp(path.join(tmpdir(), "journal-recovery-"));
    try {
      const root = await realpath(temp);
      const directory = path.join(root, "device-broker");
      await mkdir(directory);
      const id = randomUUID();
      const marker: SafetyFaultEntry = {
        id,
        revision: 1,
        owner: { kind: "core", adapter: "motor", hostEpoch: id, workbenchInstance: id },
        providerId: "kobrixa.device-ev3",
        providerGeneration: 1,
        physical: {
          providerId: "kobrixa.device-ev3",
          family: "ev3",
          basis: "serial",
          digest: "a".repeat(64),
          strength: "stable",
        },
        sessionId: id,
        operationId: id,
        operationClass: "finite-motion",
        createdAt: 1,
        updatedAt: 1,
        state: "pending",
        dispatch: "sent",
        movement: "unknown",
        stopRequested: false,
        stopConfirmation: "pending",
        cause: "none",
        resolution: null,
      };
      const bytes = Buffer.from(JSON.stringify(journalDocument(1, [marker])));
      await writeFile(path.join(directory, "faults.json"), bytes);
      const barriers: string[] = [];
      const fs = createJournalFilesystem(root, async (target) => {
        barriers.push(target);
        if (target === (point === "root" ? directory : root))
          throw Object.assign(new Error("barrier unavailable"), { code: "ENOTSUP" });
      });
      const journal = createJournal(fs, { hostEpoch: id, assertHeld() {} });
      await journal.load();
      expect(barriers).toEqual(point === "root" ? [directory] : [directory, root]);
      expect(journal.snapshot()).toMatchObject({
        journalHealth: "unwritable",
        blockers: [id],
        faults: [{ id, state: "unconfirmed", cause: "host-restarted" }],
      });
      await expect(journal.commit(journalDocument(2, [marker]))).rejects.toThrow(
        "journal write blocked",
      );
      const next = `faults.next-${randomUUID()}.json`;
      await expect(fs.write(next, bytes)).rejects.toThrow("journal not writable");
      await expect(fs.sync("faults.json")).rejects.toThrow("journal not writable");
      await expect(fs.replace("faults.json", "faults.previous.json")).rejects.toThrow(
        "journal not writable",
      );
      await expect(fs.remove("faults.json")).rejects.toThrow("journal not writable");
      expect(await fs.inventory()).toEqual([{ name: "faults.json", bytes: bytes.length }]);
      expect(await readFile(path.join(directory, "faults.json"))).toEqual(bytes);
      // Read-only recovery still applies the ordinary unsafe-evidence checks.
      await symlink(
        path.join(directory, "faults.json"),
        path.join(directory, "faults.previous.json"),
      );
      await expect(fs.inventory()).rejects.toThrow("journal unsafe evidence");
      await expect(fs.read("faults.previous.json")).rejects.toThrow("journal unsafe file");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

// This adapter models native publication; these are unit tests, never Windows receipts.
async function windowsFixture() {
  let failPhase: string | undefined;
  const temp = await mkdtemp(path.join(tmpdir(), "journal-windows-wire-"));
  const root = await realpath(temp);
  const publications: string[] = [];
  const addon = {
    apiVersion: "1",
    napiVersion: "8",
    arch: "x64",
    capabilities: () => ({ supported: true }),
    initializeDirectory: vi.fn(async (directory: string) => {
      await mkdir(directory);
      return { supported: true, flushed: true };
    }),
    syncDirectory: vi.fn(() => ({ supported: true, flushed: true })),
    async durableReplace(directory: string, target: string, _temporary: string, bytes: Buffer) {
      publications.push(target);
      // Fail the current publication after the successful previous publication.
      const failure = target === "faults.json" ? failPhase : undefined;
      const published =
        !failure || ["move", "flush-published", "flush-directory"].includes(failure);
      if (published) await writeFile(path.join(directory, target), bytes);
      if (failure)
        throw Object.assign(new Error("native failure"), {
          code: "EIO",
          phase: failure,
          publicationState: published ? "uncertain" : "not-published",
        });
      return { supported: true, published: true, fileFlushed: true, directoryFlushed: true };
    },
  };
  const adapter = createWin32JournalAdapter({
    location: async () => ({ packaged: true, resourcesPath: root, appPath: root }),
    execute: (_filename, operation, args) =>
      invokeWin32JournalAddon(() => addon, operation, args, "x64", 8),
  });
  const fs = createJournalFilesystem(root, undefined, adapter);
  const journal = createJournal(fs, { hostEpoch: randomUUID(), assertHeld() {} });
  await journal.load();
  return {
    temp,
    root,
    publications,
    journal,
    fs,
    addon,
    fail: (phase: string) => {
      failPhase = phase;
    },
  };
}
it("W02b uses native publication in previous/current order and reopens committed bytes", async () => {
  const { temp, root, publications, journal, addon } = await windowsFixture();
  try {
    await journal.commit(journalDocument(1, []));
    await journal.commit(journalDocument(2, []));
    expect(publications).toEqual(["faults.json", "faults.previous.json", "faults.json"]);
    expect(
      JSON.parse(await readFile(path.join(root, "device-broker/faults.json"), "utf8")),
    ).toEqual(journalDocument(2, []));
    expect(
      JSON.parse(await readFile(path.join(root, "device-broker/faults.previous.json"), "utf8")),
    ).toEqual(journalDocument(1, []));
    expect(journal.snapshot().journalHealth).toBe("ready");
    // Native initialization includes both barriers; replacements include their own.
    expect(addon.initializeDirectory).toHaveBeenCalledExactlyOnceWith(
      path.join(root, "device-broker"),
    );
    expect(addon.syncDirectory).not.toHaveBeenCalled();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
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
])("W02b native %s failure cannot acknowledge a commit or permit another write", async (phase) => {
  const { temp, root, publications, journal, fs, fail } = await windowsFixture();
  try {
    const id = randomUUID();
    const marker: SafetyFaultEntry = {
      id,
      revision: 1,
      owner: { kind: "core", adapter: "motor", hostEpoch: id, workbenchInstance: id },
      providerId: "kobrixa.device-ev3",
      providerGeneration: 1,
      physical: {
        providerId: "kobrixa.device-ev3",
        family: "ev3",
        basis: "serial",
        digest: "a".repeat(64),
        strength: "stable",
      },
      sessionId: id,
      operationId: id,
      operationClass: "finite-motion",
      createdAt: 1,
      updatedAt: 1,
      state: "pending",
      dispatch: "sent",
      movement: "unknown",
      stopRequested: false,
      stopConfirmation: "pending",
      cause: "none",
      resolution: null,
    };
    const initial = journalDocument(1, [marker]);
    const next = journalDocument(2, [
      { ...marker, revision: 2, updatedAt: 2, state: "unconfirmed" },
    ]);
    await journal.commit(initial);
    fail(phase);
    const published = ["move", "flush-published", "flush-directory"].includes(phase);
    await expect(journal.commit(next)).rejects.toMatchObject({
      code: "EIO",
      phase,
      publicationState: published ? "uncertain" : "not-published",
    });
    // These retained blockers and unwritable health prohibit clean close/update.
    expect(journal.snapshot()).toMatchObject({
      revision: 1,
      journalHealth: "unwritable",
      blockers: [id],
      faults: [{ state: "pending" }],
    });
    await expect(journal.commit(next)).rejects.toThrow("journal write blocked");
    expect(publications).toEqual(["faults.json", "faults.previous.json", "faults.json"]);
    expect(
      JSON.parse(await readFile(path.join(root, "device-broker/faults.json"), "utf8")),
    ).toEqual(published ? next : initial);
    expect(
      JSON.parse(await readFile(path.join(root, "device-broker/faults.previous.json"), "utf8")),
    ).toEqual(initial);
    const reopened = createJournal(fs, { hostEpoch: randomUUID(), assertHeld() {} });
    await reopened.load();
    expect(reopened.snapshot()).toMatchObject({
      revision: published ? 2 : 1,
      blockers: [id],
      faults: [{ id, state: "unconfirmed", movement: "unknown", cause: "host-restarted" }],
    });
    await expectCloseAndUpdateBlocked(journal);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("W02b retains aggregate inventory reservation before native dispatch", async () => {
  const { temp, root, publications, journal } = await windowsFixture();
  try {
    await writeFile(
      path.join(root, "device-broker", `faults.next-${randomUUID()}.json`),
      Buffer.alloc(8388608),
    );
    await expect(journal.commit(journalDocument(1, []))).rejects.toThrow(
      "journal replacement quota",
    );
    expect(publications).toEqual([]);
    expect(journal.snapshot().journalHealth).toBe("unwritable");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("W02b timeout cleanup leaves native staging fenced even after late settlement", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-native-late-"));
  let settle!: () => void;
  const root = await realpath(temp);
  const adapter = createWin32JournalAdapter({
    location: async () => ({ packaged: true, resourcesPath: root, appPath: root }),
    execute: async (_filename, operation, args) => {
      if (operation === "initializeDirectory") await mkdir(args[0]);
      if (operation === "durableReplace")
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
    },
  });
  const fs = createJournalFilesystem(root, undefined, adapter);
  try {
    await fs.initialize();
    const temporary = `faults.next-${randomUUID()}.json`;
    await writeFile(path.join(root, "device-broker", temporary), "retained staging");
    vi.useFakeTimers();
    const pending = adapter.durableReplace(root, "faults.json", temporary, Buffer.from("next"));
    const failed = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    await expect(fs.remove(temporary)).rejects.toMatchObject({ code: "EBUSY" });
    settle();
    await Promise.resolve();
    await expect(fs.remove(temporary)).rejects.toMatchObject({ code: "EBUSY" });
    expect(await readFile(path.join(root, "device-broker", temporary), "utf8")).toBe(
      "retained staging",
    );
  } finally {
    vi.useRealTimers();
    await rm(temp, { recursive: true, force: true });
  }
});
it.each(["missing", "wrong-abi", "unsupported-volume"])(
  "W02b %s addon retains old pending faults and blocks resolution",
  async (failure) => {
    const temp = await mkdtemp(path.join(tmpdir(), "journal-unavailable-"));
    try {
      const root = await realpath(temp);
      const id = randomUUID();
      const marker: SafetyFaultEntry = {
        id,
        revision: 1,
        owner: { kind: "core", adapter: "motor", hostEpoch: id, workbenchInstance: id },
        providerId: "kobrixa.device-ev3",
        providerGeneration: 1,
        physical: {
          providerId: "kobrixa.device-ev3",
          family: "ev3",
          basis: "serial",
          digest: "a".repeat(64),
          strength: "stable",
        },
        sessionId: id,
        operationId: id,
        operationClass: "finite-motion",
        createdAt: 1,
        updatedAt: 1,
        state: "pending",
        dispatch: "sent",
        movement: "unknown",
        stopRequested: false,
        stopConfirmation: "pending",
        cause: "none",
        resolution: null,
      };
      await mkdir(path.join(root, "device-broker"));
      const bytes = Buffer.from(JSON.stringify(journalDocument(1, [marker])));
      await writeFile(path.join(root, "device-broker/faults.json"), bytes);
      const mutation = vi.fn();
      const adapter = createWin32JournalAdapter({
        location: async () => ({ packaged: true, resourcesPath: root, appPath: root }),
        execute: (_filename, operation, args) =>
          invokeWin32JournalAddon(
            () => {
              if (failure === "missing")
                throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" });
              return {
                apiVersion: failure === "wrong-abi" ? "0" : "1",
                arch: "x64",
                napiVersion: "8",
                capabilities: () => ({ supported: false }),
                initializeDirectory: () => {
                  throw Object.assign(new Error("unsupported volume"), { code: "ENOTSUP" });
                },
                syncDirectory: mutation,
                durableReplace: mutation,
              };
            },
            operation,
            args,
            "x64",
            8,
          ),
      });
      const fs = createJournalFilesystem(root, undefined, adapter);
      await expect(fs.initialize()).rejects.toMatchObject({ code: "ENOTSUP" });
      const journal = createJournal(fs, { hostEpoch: id, assertHeld() {} });
      await journal.load();
      expect(journal.snapshot()).toMatchObject({
        journalHealth: "unwritable",
        blockers: [id],
        faults: [{ id, state: "unconfirmed", cause: "host-restarted" }],
      });
      await expect(journal.commit(journalDocument(2, []))).rejects.toThrow("journal write blocked");
      expect(mutation).not.toHaveBeenCalled();
      expect(await readFile(path.join(root, "device-broker/faults.json"))).toEqual(bytes);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

it("Windows delegates absent journal creation before exposing a writable filesystem", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-private-create-"));
  const root = await realpath(temp);
  const leaf = path.join(root, "device-broker");
  const initializeDirectory = vi.fn(async (directory: string) => {
    expect(directory).toBe(leaf);
    await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(leaf); // Unit stand-in; native suite checks the actual creation DACL.
  });
  const syncDirectory = vi.fn(async () => {});
  const durableReplace = vi.fn(async () => {});
  const fs = createJournalFilesystem(root, undefined, {
    initializeDirectory,
    syncDirectory,
    durableReplace,
    assertIdle() {},
    dispose() {},
  });
  try {
    await expect(
      fs.durableReplace!(
        "faults.next-00000000-0000-4000-8000-000000000001.json",
        "faults.json",
        Buffer.from("x"),
      ),
    ).rejects.toThrow("journal not writable");
    await fs.initialize();
    expect(initializeDirectory).toHaveBeenCalledExactlyOnceWith(leaf);
    expect(syncDirectory).not.toHaveBeenCalled(); // Native initialization flushes both directories.
    expect(await fs.inventory()).toEqual([]);
    expect(durableReplace).not.toHaveBeenCalled();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it("unsafe existing Windows ACL refusal preserves readable evidence and blocks writes", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-private-refusal-"));
  const root = await realpath(temp);
  const leaf = path.join(root, "device-broker");
  const failure = Object.assign(
    new Error("journal DACL permits another principal to mutate evidence"),
    { code: "EUNSAFE" },
  );
  const durableReplace = vi.fn(async () => {});
  const fs = createJournalFilesystem(root, undefined, {
    initializeDirectory: async () => {
      throw failure;
    },
    syncDirectory: async () => {},
    durableReplace,
    assertIdle() {},
    dispose() {},
  });
  try {
    await mkdir(leaf);
    await writeFile(path.join(leaf, "faults.json"), "retained");
    await expect(fs.initialize()).rejects.toBe(failure);
    expect(Buffer.from((await fs.read("faults.json"))!).toString()).toBe("retained");
    expect(await fs.inventory()).toEqual([{ name: "faults.json", bytes: 8 }]);
    await expect(
      fs.durableReplace!(
        "faults.next-00000000-0000-4000-8000-000000000001.json",
        "faults.json",
        Buffer.from("x"),
      ),
    ).rejects.toThrow("journal not writable");
    expect(durableReplace).not.toHaveBeenCalled();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
