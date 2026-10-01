import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import {
  DeviceOperationError,
  managedPath,
  remoteChild,
  UsbTransport,
  WiFiTransport,
  normalizeDeviceError,
  type DeviceDescriptor,
  type DeviceSession,
} from "@kobrixa/device";
import { remoteFileOperation } from "./remote-files.js";
import { FileBatchManager } from "./file-batch.js";
import type { FileBatchRequest, FileBatchRef, FileBatchSnapshot } from "../../shared/api.js";
import type { RemoteFileRequest, RemoteFileResult, DeviceEvent } from "../../shared/api.js";
import type { BuildService } from "../workspace/build.js";

export function mergeDiscoveryResults(
  settled: PromiseSettledResult<DeviceDescriptor[]>[],
): DeviceDescriptor[] {
  const devices = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (devices.length) return devices;
  const rejection = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejection) throw rejection.reason;
  return [];
}

export function deploymentTargets(
  files: Array<{ path: string; remotePath: string }>,
  remoteDirectory: string,
): Array<{ path: string; remotePath: string }> {
  return files.map((file) => {
    const relative = file.remotePath.replaceAll("\\", "/");
    if (relative.startsWith("/") || relative.split("/").some((part) => part === "..")) {
      throw new DeviceOperationError("transfer", `Unsafe asset deployment path '${relative}'.`);
    }
    return { path: file.path, remotePath: path.posix.join(remoteDirectory, relative) };
  });
}

export class DeviceService {
  readonly #sessions = new Map<string, DeviceSession>();
  readonly #busy = new Map<string, AbortController>();
  get busy(): boolean {
    return this.#busy.size > 0;
  }
  readonly #usb = new UsbTransport();
  readonly #wifi = new WiFiTransport();
  private batches: FileBatchManager | undefined;
  private batchOwners = new WeakSet<WebContents>();

  constructor(
    private readonly builds: BuildService,
    private readonly renderer: () => WebContents | undefined,
  ) {}

  async discover(signal = new AbortController().signal): Promise<DeviceDescriptor[]> {
    const settled = await Promise.allSettled([
      this.#usb.discover(signal),
      this.#wifi.discover(signal),
    ]);
    return mergeDiscoveryResults(settled);
  }

  connect(descriptor: DeviceDescriptor, signal = new AbortController().signal): Promise<string> {
    const transport = descriptor.transport === "usb" ? this.#usb : this.#wifi;
    return this.connectWith(() => transport.connect(descriptor, signal), descriptor.transport);
  }

  connectWifi(address: string, signal = new AbortController().signal): Promise<string> {
    const descriptor: DeviceDescriptor = {
      id: `wifi:${address}`,
      name: `EV3 ${address}`,
      transport: "wifi",
      address,
    };
    return this.connectWith(() => this.#wifi.connect(descriptor, signal), "wifi");
  }

  async disconnect(id: string): Promise<void> {
    const session = this.require(id);
    this.#busy.get(id)?.abort();
    await session.disconnect();
    this.#sessions.delete(id);
    this.send({ type: "state", state: "disconnected", sessionId: id });
  }

  upload(id: string, buildId: string, remotePath: string): Promise<void> {
    return this.operation(id, async (session, signal) =>
      session.upload(remotePath, await this.builds.artifactBytes(buildId), signal),
    );
  }

  deploy(id: string, buildId: string, remoteDirectory: string): Promise<void> {
    return this.operation(id, async (session, signal) => {
      const files = await this.builds.deployableArtifacts(buildId);
      for (const file of deploymentTargets(files, remoteDirectory)) {
        try {
          await session.upload(file.remotePath, await readFile(file.path), signal);
        } catch (error) {
          throw new DeviceOperationError(
            "transfer",
            `Unable to deploy '${file.remotePath}': ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
  }

  run(id: string, remotePath: string): Promise<void> {
    return this.operation(id, (session, signal) => session.run(remotePath, signal));
  }

  stop(id: string): Promise<void> {
    return this.operation(id, (session, signal) => session.stop(undefined, signal));
  }

  delete(id: string, remotePath: string): Promise<void> {
    return this.operation(id, (session, signal) => session.delete(remotePath, signal));
  }

  async files(request: RemoteFileRequest): Promise<RemoteFileResult> {
    try {
      const target = managedPath(
        request.path,
        ["rename", "delete", "download"].includes(request.action),
      );
      if (request.action === "mkdir" || request.action === "rename")
        remoteChild(
          request.action === "mkdir" ? target : path.posix.dirname(target),
          request.name ?? "",
        );
      return await this.operation(request.sessionId, async (session, signal) => {
        const { dialog } = await import("electron");
        return remoteFileOperation(
          request,
          session,
          signal,
          dialog,
          (paths) =>
            this.send({
              type: "files-changed",
              sessionId: request.sessionId,
              requestId: request.requestId,
              paths,
            }),
          (transferred, total) =>
            this.send({
              type: "file-progress",
              sessionId: request.sessionId,
              requestId: request.requestId,
              transferred,
              total,
            }),
        );
      });
    } catch (error) {
      const normalized = normalizeDeviceError(error);
      return {
        ok: false,
        sessionId: request.sessionId,
        requestId: request.requestId,
        category: normalized.category,
        message: normalized.message,
      };
    }
  }

  async prepareFiles(request: FileBatchRequest, owner: WebContents): Promise<FileBatchSnapshot> {
    const { dialog } = await import("electron");
    this.batches ??= new FileBatchManager(
      (id, work) => this.operation(id, work),
      dialog,
      (snapshot) => this.send({ type: "file-batch", snapshot }),
      (request, paths) =>
        this.send({
          type: "files-changed",
          sessionId: request.sessionId,
          requestId: request.requestId,
          paths,
        }),
    );
    if (!this.batchOwners.has(owner)) {
      this.batchOwners.add(owner);
      const ownerId = owner.id;
      owner.once("destroyed", () => this.batches?.abandonOwner(ownerId));
      owner.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) this.batches?.abandonOwner(ownerId);
      });
    }
    return this.batches.prepare(request, owner.id);
  }
  async executeFiles(
    ref: FileBatchRef,
    policy: "skip" | "replace",
    owner: number,
  ): Promise<FileBatchSnapshot> {
    if (!this.batches) throw new Error("Unknown file operation.");
    return this.batches.execute(ref, policy, owner);
  }
  async stopFiles(ref: FileBatchRef, owner: number): Promise<void> {
    if (!this.batches) throw new Error("Unknown file operation.");
    return this.batches.stop(ref, owner);
  }

  private async connectWith(
    connect: () => Promise<DeviceSession>,
    transport: string,
  ): Promise<string> {
    this.send({ type: "state", state: "connecting", transport });
    try {
      const session = await connect();
      const id = randomUUID();
      this.#sessions.set(id, session);
      this.send({ type: "state", state: "connected", sessionId: id, transport });
      return id;
    } catch (error) {
      this.report(error);
      throw error;
    }
  }

  private async operation<T>(
    id: string,
    work: (session: DeviceSession, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const session = this.require(id);
    if (this.#busy.has(id))
      throw new DeviceOperationError("device", "Another EV3 operation is in progress.");
    const controller = new AbortController();
    this.#busy.set(id, controller);
    this.send({
      type: "state",
      state: "busy",
      sessionId: id,
      transport: session.descriptor.transport,
    });
    try {
      const result = await work(session, controller.signal);
      controller.signal.throwIfAborted();
      this.send({
        type: "state",
        state: "connected",
        sessionId: id,
        transport: session.descriptor.transport,
      });
      return result;
    } catch (error) {
      const normalized = normalizeDeviceError(error);
      if (["connection", "timeout", "protocol"].includes(normalized.category)) {
        this.#sessions.delete(id);
        await session.disconnect().catch(() => {});
        this.send({
          type: "state",
          state: "disconnected",
          sessionId: id,
          message: normalized.message,
        });
      }
      throw normalized;
    } finally {
      this.#busy.delete(id);
    }
  }

  private require(id: string): DeviceSession {
    const session = this.#sessions.get(id);
    if (!session)
      throw new DeviceOperationError("connection", "Unknown or disconnected EV3 session.");
    return session;
  }

  private report(error: unknown): void {
    const normalized = normalizeDeviceError(error);
    this.send({
      type: "error",
      category: normalized.category,
      message: normalized.message,
      recoverable: normalized.recoverable,
    });
    this.send({ type: "state", state: "error" });
  }

  private send(event: DeviceEvent): void {
    const renderer = this.renderer();
    if (renderer && !renderer.isDestroyed?.()) renderer.send("device:event", event);
  }
}
