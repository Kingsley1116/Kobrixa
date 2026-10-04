import path from "node:path";
import { managedPath, parseDirectoryListing } from "./files.js";
import type {
  RemoteEntry,
  TransferProgress,
  DeviceDescriptor,
  DeviceSession,
  Ev3Connection,
} from "./contracts.js";
import { DeviceOperationError, normalizeDeviceError, withTimeout } from "./errors.js";
import { normalizeRemotePath } from "./path.js";
import { readInputModes, readMonitor, setInputMode } from "./monitor.js";
import type { DeviceInputModes, DeviceMonitorSnapshot } from "./monitor-types.js";

const SYSTEM_COMMAND_REPLY = 0x01;
const DIRECT_COMMAND_REPLY = 0x00;
const DIRECT_COMMAND_NO_REPLY = 0x80;
const DIRECT_REPLY = 0x02;
const DIRECT_REPLY_ERROR = 0x04;
const BEGIN_DOWNLOAD = 0x92;
const CONTINUE_DOWNLOAD = 0x93;
const BEGIN_UPLOAD = 0x94;
const CONTINUE_UPLOAD = 0x95;
const CLOSE_FILEHANDLE = 0x98;
const LIST_FILES = 0x99;
const CONTINUE_LIST_FILES = 0x9a;
const CREATE_DIR = 0x9b;
const SYSTEM_REPLY_OK = 0x00;

function uint32(value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return [...bytes];
}

function lcs(value: string): number[] {
  return [0x84, ...new TextEncoder().encode(value), 0];
}

function systemStatusMessage(status: number): string {
  return (
    (
      {
        1: "Unknown file handle.",
        2: "File handle is not ready.",
        3: "File is corrupt.",
        4: "No file handles are available.",
        5: "EV3 denied file permission.",
        6: "EV3 rejected the path.",
        7: "File already exists.",
        8: "Unexpected end of file.",
        9: "File size is invalid.",
        10: "EV3 reported an unknown file error.",
        11: "EV3 rejected the filename.",
        12: "Illegal connection.",
      } as Record<number, string>
    )[status] ?? `EV3 system error ${status}.`
  );
}

export class EV3DeviceSession implements DeviceSession {
  connected = true;
  #operation: Promise<unknown> | undefined;
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private readonly unsubscribeConnection: (() => void) | undefined;
  private closed = false;

  constructor(
    readonly descriptor: DeviceDescriptor,
    private readonly connection: Ev3Connection,
  ) {
    this.unsubscribeConnection = connection.onDisconnect?.((error) => {
      this.connected = false;
      for (const listener of this.disconnectListeners) listener(error);
    });
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.unsubscribeConnection?.();
    this.disconnectListeners.clear();
    await this.connection.close();
  }

  readMonitor(
    signal: AbortSignal,
    shouldYield?: () => boolean,
  ): Promise<DeviceMonitorSnapshot | undefined> {
    return this.exclusive(() => readMonitor(this.connection, signal, shouldYield));
  }

  readInputModes(
    port: number,
    expectedType: number,
    signal: AbortSignal,
    shouldYield?: () => boolean,
  ): Promise<DeviceInputModes | undefined> {
    return this.exclusive(() =>
      readInputModes(this.connection, port, expectedType, signal, shouldYield),
    );
  }

  setInputMode(
    port: number,
    expectedType: number,
    mode: number,
    signal: AbortSignal,
  ): Promise<DeviceMonitorSnapshot> {
    return this.exclusive(() => setInputMode(this.connection, port, expectedType, mode, signal));
  }

  upload(remotePath: string, data: Uint8Array, signal: AbortSignal): Promise<void> {
    return this.uploadStream(
      remotePath,
      data.length,
      (async function* () {
        yield data;
      })(),
      signal,
    );
  }

  uploadStream(
    remotePath: string,
    size: number,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    progress?: TransferProgress,
  ): Promise<void> {
    return this.exclusive(async () => {
      const target = normalizeRemotePath(remotePath);
      if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff)
        throw new DeviceOperationError("transfer", "File size exceeds the EV3 transfer limit.");
      const begin = await this.systemReply(
        BEGIN_DOWNLOAD,
        Uint8Array.from([...uint32(size), ...new TextEncoder().encode(target), 0]),
        signal,
        10_000,
        [0, 8],
      );
      const handle = begin.data[0];
      if (handle === undefined || handle === 0xff)
        throw new DeviceOperationError("protocol", "EV3 did not return a download handle.");
      let closed = begin.status === 8;
      let transferred = 0;
      try {
        for await (const data of chunks) {
          for (let offset = 0; offset < data.length; offset += 900) {
            signal.throwIfAborted();
            const chunk = data.slice(offset, offset + 900);
            if (transferred + chunk.length > size || closed)
              throw new DeviceOperationError("transfer", "Source file changed during upload.");
            const reply = await this.systemReply(
              CONTINUE_DOWNLOAD,
              Uint8Array.from([handle, ...chunk]),
              signal,
              10_000,
              transferred + chunk.length === size ? [0, 8] : [0],
            );
            closed = reply.status === 8;
            transferred += chunk.length;
            progress?.(transferred, size);
          }
        }
        if (transferred !== size)
          throw new DeviceOperationError("transfer", "Source file changed during upload.");
        progress?.(size, size);
      } finally {
        if (!closed) await this.closeHandle(handle);
      }
    });
  }

  list(directory: string, signal: AbortSignal): Promise<RemoteEntry[]> {
    return this.exclusive(() => this.listRaw(normalizeRemotePath(directory), signal));
  }
  private async listRaw(directory: string, signal: AbortSignal): Promise<RemoteEntry[]> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let listing = "";
    await this.readTransfer(
      LIST_FILES,
      CONTINUE_LIST_FILES,
      `${directory.replace(/\/$/, "")}/`,
      async (chunk) => {
        listing += decoder.decode(chunk, { stream: true });
      },
      signal,
      undefined,
      8 * 1024 * 1024,
    );
    return parseDirectoryListing(directory, listing + decoder.decode());
  }
  download(
    remotePath: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
    progress?: TransferProgress,
  ): Promise<void> {
    return this.exclusive(() =>
      this.readTransfer(
        BEGIN_UPLOAD,
        CONTINUE_UPLOAD,
        normalizeRemotePath(remotePath),
        sink,
        signal,
        progress,
      ),
    );
  }
  // 900-byte replies fit USB HID and Wi-Fi. Decode records only after all chunks
  // arrive: the firmware may split an entry or a UTF-8 sequence between packets.
  private async readTransfer(
    begin: number,
    next: number,
    remotePath: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
    progress?: TransferProgress,
    maximum = 0xffffffff,
  ): Promise<void> {
    const readSize = [900 & 255, 900 >> 8];
    const first = await this.systemReply(
      begin,
      Uint8Array.from([...readSize, ...new TextEncoder().encode(remotePath), 0]),
      signal,
      10_000,
      [0, 8],
    );
    if (first.data.length < 5)
      throw new DeviceOperationError("protocol", "Truncated EV3 transfer header.");
    const total = new DataView(first.data.buffer, first.data.byteOffset).getUint32(0, true);
    const handle = first.data[4]!;
    let closed = first.status === 8;
    try {
      if (total > maximum)
        throw new DeviceOperationError(
          "transfer",
          "EV3 directory listing exceeds the supported size.",
        );
      let chunk = first.data.slice(5),
        status = first.status,
        transferred = 0;
      for (;;) {
        signal.throwIfAborted();
        transferred += chunk.length;
        if (transferred > total || (status === 8 && transferred !== total))
          throw new DeviceOperationError(
            "protocol",
            "EV3 returned an incomplete or oversized transfer.",
          );
        await sink(chunk);
        progress?.(transferred, total);
        if (transferred === total) break;
        if (!chunk.length)
          throw new DeviceOperationError("protocol", "EV3 transfer made no progress.");
        const reply = await this.systemReply(
          next,
          Uint8Array.from([handle, ...readSize]),
          signal,
          10_000,
          [0, 8],
        );
        closed = reply.status === 8;
        if (reply.data[0] !== handle)
          throw new DeviceOperationError("protocol", "EV3 returned the wrong file handle.");
        chunk = reply.data.slice(1);
        status = reply.status;
      }
    } finally {
      if (!closed && handle !== 0xff) await this.closeHandle(handle);
    }
  }
  private async closeHandle(handle: number): Promise<void> {
    // EOF normally closes the handle. UNKNOWN_HANDLE is harmless during cleanup.
    await this.system(
      CLOSE_FILEHANDLE,
      Uint8Array.of(handle),
      new AbortController().signal,
      5000,
      [0, 1],
    ).catch(() => {});
  }
  createDirectory(remotePath: string, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const target = managedPath(remotePath, true);
      await this.system(
        CREATE_DIR,
        Uint8Array.from([...new TextEncoder().encode(target), 0]),
        signal,
        5000,
      );
    });
  }
  rename(source: string, destination: string, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const from = managedPath(source, true),
        to = managedPath(destination, true);
      if (from === to) return;
      if (path.posix.dirname(from) !== path.posix.dirname(to))
        throw new DeviceOperationError("protocol", "Rename must stay in the same folder.");
      const siblings = await this.listRaw(path.posix.dirname(from), signal);
      const entry = siblings.find((item) => item.path === from);
      if (!entry) throw new DeviceOperationError("not-found", "The source no longer exists.");
      if (siblings.some((item) => item.path === to))
        throw new DeviceOperationError("device", "A file or folder with that name already exists.");
      const snapshot = async (root: RemoteEntry): Promise<string> => {
        const rows: string[] = [];
        let count = 0;
        const visit = async (item: RemoteEntry, depth: number): Promise<void> => {
          if (++count > 10000 || depth > 64)
            throw new DeviceOperationError("transfer", "The folder is too large to verify safely.");
          rows.push(
            JSON.stringify([
              item.path.slice(root.path.length),
              item.kind,
              item.size,
              item.checksum,
            ]),
          );
          if (item.kind === "directory")
            for (const child of await this.listRaw(item.path, signal))
              await visit(child, depth + 1);
        };
        await visit(root, 0);
        return rows.sort().join("\n");
      };
      const before = await snapshot(entry);
      // In stock firmware opFILE MOVE is a COPY, not a rename. It also does not
      // report filesystem failures, so verify both trees before removing source.
      try {
        await this.direct(Uint8Array.from([0, 0, 0, 0xc0, 31, ...lcs(from), ...lcs(to)]), signal);
        const after = await this.listRaw(path.posix.dirname(from), signal);
        const copied = after.find((item) => item.path === to),
          original = after.find((item) => item.path === from);
        if (
          !copied ||
          !original ||
          (await snapshot(copied)) !== before ||
          (await snapshot(original)) !== before
        )
          throw new DeviceOperationError(
            "transfer",
            "Copy verification failed; the source was not deleted.",
          );
      } catch (error) {
        const normalized = normalizeDeviceError(error, "transfer");
        throw new DeviceOperationError(
          ["connection", "timeout", "protocol"].includes(normalized.category)
            ? normalized.category
            : "transfer",
          `Rename was not completed. Source retained at ${from}; a partial copy may remain at ${to}. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await this.removeRaw(from, signal);
      } catch (error) {
        const normalized = normalizeDeviceError(error, "transfer");
        throw new DeviceOperationError(
          ["connection", "timeout", "protocol"].includes(normalized.category)
            ? normalized.category
            : "transfer",
          `Verified copy exists at ${to}, but removing ${from} did not complete. Refresh both locations. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  run(remotePath: string, signal: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const target = normalizeRemotePath(remotePath);
      const bytecode = [0xc0, 0x08, 0x01, ...lcs(target), 0x60, 0x64, 0x03, 0x01, 0x60, 0x64, 0x00];
      await this.connection.transmit(
        Uint8Array.from([DIRECT_COMMAND_NO_REPLY, 0x08, 0x00, ...bytecode]),
        signal,
      );
    });
  }

  stop(_programName?: string, signal = new AbortController().signal): Promise<void> {
    return this.exclusive(() =>
      this.direct(Uint8Array.from([DIRECT_COMMAND_REPLY, 0x00, 0x00, 0x02, 0x01]), signal),
    );
  }

  delete(remotePath: string, signal: AbortSignal): Promise<void> {
    return this.exclusive(() => this.removeRaw(normalizeRemotePath(remotePath), signal));
  }
  private async removeRaw(target: string, signal: AbortSignal): Promise<void> {
    // System DELETE_FILE truncates paths to 59 bytes in stock firmware. opFILE
    // REMOVE accepts the existing 119-byte path limit and handles directories.
    await this.direct(Uint8Array.from([0, 0, 0, 0xc0, 30, ...lcs(target)]), signal);
    if (
      (await this.listRaw(path.posix.dirname(target), signal)).some(
        (entry) => entry.path === target,
      )
    )
      throw new DeviceOperationError(
        "device",
        "EV3 did not remove the item. Refresh to inspect any partially removed contents.",
      );
  }

  private async systemReply(
    command: number,
    data: Uint8Array,
    signal: AbortSignal,
    timeout: number,
    acceptedStatuses: readonly number[] = [SYSTEM_REPLY_OK],
  ): Promise<{ data: Uint8Array; status: number }> {
    signal.throwIfAborted();
    const reply = await withTimeout(
      (bounded) =>
        this.connection.exchange(
          Uint8Array.from([SYSTEM_COMMAND_REPLY, command, ...data]),
          bounded,
          timeout,
        ),
      signal,
      timeout,
    );
    if (reply.length < 3 || (reply[0] !== 0x03 && reply[0] !== 0x05) || reply[1] !== command) {
      throw new DeviceOperationError("protocol", "Malformed EV3 system reply.");
    }
    const status = reply[2]!;
    if (!acceptedStatuses.includes(status)) {
      const category = status === 5 ? "permission" : status === 9 ? "transfer" : "device";
      throw new DeviceOperationError(category, systemStatusMessage(status));
    }
    return { data: reply.slice(3), status };
  }

  private async system(
    command: number,
    data: Uint8Array,
    signal: AbortSignal,
    timeout: number,
    acceptedStatuses: readonly number[] = [0],
  ): Promise<Uint8Array> {
    return (await this.systemReply(command, data, signal, timeout, acceptedStatuses)).data;
  }

  private async direct(payload: Uint8Array, signal: AbortSignal): Promise<void> {
    const reply = await withTimeout(
      (bounded) => this.connection.exchange(payload, bounded, 5000),
      signal,
      5000,
    );
    if (reply[0] === DIRECT_REPLY_ERROR)
      throw new DeviceOperationError("device", "EV3 rejected the direct command.");
    if (reply[0] !== DIRECT_REPLY)
      throw new DeviceOperationError("protocol", "Malformed EV3 direct-command reply.");
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.connected)
      throw new DeviceOperationError("connection", "The EV3 session is disconnected.", true);
    if (this.#operation)
      throw new DeviceOperationError(
        "device",
        "Another state-changing operation is already running.",
        true,
      );
    const pending = operation();
    this.#operation = pending;
    try {
      return await pending;
    } catch (error) {
      throw normalizeDeviceError(error, "device");
    } finally {
      this.#operation = undefined;
    }
  }
}
