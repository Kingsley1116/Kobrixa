import { Worker } from "node:worker_threads";
import path from "node:path";

export type Win32JournalOperation = "initializeDirectory" | "syncDirectory" | "durableReplace";
export interface Win32JournalAdapter {
  assertIdle(): void;
  dispose(): void;
  initializeDirectory(directory: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
  durableReplace(
    directory: string,
    target: string,
    temporary: string,
    bytes: Uint8Array,
  ): Promise<void>;
}
export interface Win32JournalLocation {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}
// Part B's only runtime placement contract. Packaged runs never consult cwd,
// environment overrides, source files, or a second addon location.
export function journalWin32AddonPath(location: Win32JournalLocation): string {
  return location.packaged
    ? path.join(
        location.resourcesPath,
        "app.asar.unpacked",
        "native",
        "journal-win32",
        "journal_win32.node",
      )
    : path.join(
        location.appPath,
        "native",
        "journal-win32",
        "build",
        "Release",
        "journal_win32.node",
      );
}

// Self-contained so exactly this validation runs in the worker and fake-addon tests.
export async function invokeWin32JournalAddon(
  load: () => unknown,
  operation: Win32JournalOperation,
  args: [string, ...unknown[]],
  arch: string,
  napi: number,
  checkedDirectories = new Set<string>(),
): Promise<void> {
  const unsupported = (diagnostic: string, cause?: unknown): Error =>
    Object.assign(new Error(`Windows journal unavailable: ${diagnostic}`, { cause }), {
      code: "ENOTSUP",
      diagnostic,
    });
  let addon: Record<string, unknown>;
  try {
    addon = load() as Record<string, unknown>;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw unsupported(
      code === "MODULE_NOT_FOUND" ? "addon-missing" : "addon-load-failed-abi-or-arch",
      cause,
    );
  }
  if (
    !addon ||
    addon.apiVersion !== "1" ||
    addon.napiVersion !== "8" ||
    napi < 8 ||
    addon.arch !== arch ||
    !["x64", "arm64"].includes(arch) ||
    typeof addon.capabilities !== "function" ||
    typeof addon[operation] !== "function"
  )
    throw unsupported("addon-incompatible-api-abi-or-arch");
  if (operation !== "initializeDirectory" && !checkedDirectories.has(args[0])) {
    const capabilities = (await addon.capabilities(args[0])) as { supported?: boolean };
    if (capabilities?.supported !== true) throw unsupported("unsupported-volume");
    checkedDirectories.add(args[0]);
  }
  // Each native operation still validates the current directory, volume and ACL.
  // Only the redundant preliminary capability traversal is cached.
  // Worker structured clone produces Uint8Array, whereas the N-API API requires Buffer.
  if (operation === "durableReplace") args[3] = Buffer.from(args[3] as Uint8Array);
  const result = (await (addon[operation] as (...args: unknown[]) => unknown)(...args)) as {
    supported?: boolean;
    flushed?: boolean;
    published?: boolean;
    fileFlushed?: boolean;
    directoryFlushed?: boolean;
  };
  if (
    result?.supported !== true ||
    (operation !== "durableReplace"
      ? result.flushed !== true
      : result.published !== true ||
        result.fileFlushed !== true ||
        result.directoryFlushed !== true)
  )
    throw unsupported("invalid-native-receipt");
}

export function createWin32JournalWorker(filename: string) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const checkedDirectories = new Set();
    parentPort.on('message', ({ operation, args }) => {
      (${invokeWin32JournalAddon.toString()})(() => require(workerData.filename),
        operation, args, process.arch, Number(process.versions.napi), checkedDirectories)
        .then(() => parentPort.postMessage({ ok: true }), error => parentPort.postMessage({
          ok: false, message: error.message, code: error.code, diagnostic: error.diagnostic,
          phase: error.phase, win32Code: error.win32Code, publicationState: error.publicationState
        }));
    });
  `,
    { eval: true, execArgv: [], workerData: { filename } },
  );
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure = error;
    const current = pending;
    pending = undefined;
    worker.unref();
    current?.reject(error);
  };
  worker.on("message", (receipt: { ok: boolean; message?: string }) => {
    const current = pending;
    pending = undefined;
    worker.unref();
    if (receipt.ok) current?.resolve();
    else current?.reject(Object.assign(new Error(receipt.message), receipt));
  });
  worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", () => fail(failure ?? new Error("Windows journal worker exited")));
  // Idle workers must not keep Node/Electron alive. In-flight calls stay referenced
  // until receipt or expiry; disposal fences first and requests worker termination.
  worker.unref();
  return {
    execute(operation: Win32JournalOperation, args: [string, ...unknown[]]): Promise<void> {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new Error("Windows journal worker busy"));
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        worker.ref();
        try {
          worker.postMessage({ operation, args });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    dispose(): void {
      fail(new Error("Windows journal worker disposed"));
      // This is not evidence that an in-progress native syscall was cancelled.
      void worker.terminate().catch(() => {});
    },
  };
}

// One-shot helper for isolated tests; adapters own a persistent worker below.
export async function executeWin32JournalWorker(
  filename: string,
  operation: Win32JournalOperation,
  args: [string, ...unknown[]],
): Promise<void> {
  const worker = createWin32JournalWorker(filename);
  try {
    await worker.execute(operation, args);
  } finally {
    worker.dispose();
  }
}

export function createWin32JournalAdapter(
  options: {
    location?: () => Promise<Win32JournalLocation>;
    execute?: typeof executeWin32JournalWorker;
    workerFactory?: typeof createWin32JournalWorker;
    onQuit?: (dispose: () => void) => () => void;
  } = {},
): Win32JournalAdapter {
  let active = false;
  let expired = false;
  let disposed = false;
  let worker: ReturnType<typeof createWin32JournalWorker> | undefined;
  let removeQuitListener: (() => void) | undefined;
  const dispose = (): void => {
    disposed = true;
    worker?.dispose();
    removeQuitListener?.();
    removeQuitListener = undefined;
  };
  removeQuitListener = options.onQuit?.(dispose);
  const location =
    options.location ??
    (async () => {
      const { app } = await import("electron");
      if (!disposed && !removeQuitListener) {
        app.once("will-quit", dispose);
        removeQuitListener = () => {
          app.removeListener("will-quit", dispose);
        };
      }
      return {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      };
    });
  const assertIdle = (): void => {
    if (active || expired || disposed)
      throw Object.assign(new Error("Windows journal I/O fenced"), { code: "EBUSY" });
  };
  let filenameTask: Promise<string> | undefined;
  const call = async (
    operation: Win32JournalOperation,
    args: [string, ...unknown[]],
  ): Promise<void> => {
    assertIdle();
    active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      let filename: string;
      try {
        filenameTask ??= location().then(journalWin32AddonPath);
        filename = await filenameTask;
      } catch (cause) {
        throw Object.assign(new Error("Windows journal loader context unavailable", { cause }), {
          code: "ENOTSUP",
          diagnostic: "loader-context-unavailable",
        });
      }
      if (expired || disposed) throw new Error("Windows journal loader completed after fence");
      if (options.execute) await options.execute(filename, operation, args);
      else {
        worker ??= (options.workerFactory ?? createWin32JournalWorker)(filename);
        await worker.execute(operation, args);
      }
    })().finally(() => {
      active = false;
    });
    try {
      await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            dispose();
            reject(
              Object.assign(new Error("Windows journal I/O deadline; late I/O remains fenced"), {
                code: "ETIMEDOUT",
              }),
            );
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    assertIdle,
    dispose,
    initializeDirectory: (directory) => call("initializeDirectory", [directory]),
    syncDirectory: (directory) => call("syncDirectory", [directory]),
    durableReplace(directory, target, temporary, bytes) {
      if (!bytes.length || bytes.length > 8388608)
        return Promise.reject(new Error("journal write budget"));
      return call("durableReplace", [directory, target, temporary, bytes]);
    },
  };
}
