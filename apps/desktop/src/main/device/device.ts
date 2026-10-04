import { DevicePreferencesStore } from "./preferences.js";
import type { DevicePreferences } from "../../shared/device-preferences.js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WebContents } from "electron";
import {
  DeviceOperationError,
  managedPath,
  REMOTE_PROJECT_ROOT,
  remoteChild,
  UsbTransport,
  WiFiTransport,
  normalizeDeviceError,
  type DeviceDescriptor,
  type DeviceSession,
  type RemoteEntry,
} from "@kobrixa/device";
import { remoteFileOperation } from "./remote-files.js";
import { FileBatchManager } from "./file-batch.js";
import type { FileBatchRequest, FileBatchRef, FileBatchSnapshot } from "../../shared/api.js";
import type { RemoteFileRequest, RemoteFileResult, DeviceEvent } from "../../shared/api.js";
import type { BuildService } from "../workspace/build.js";

interface Deployment {
  buildId: string;
  files: Array<{ path: string; size: number; checksum: string }>;
}
interface Recovery {
  id: string;
  descriptor: DeviceDescriptor;
  deployment: Deployment | undefined;
  controller: AbortController;
  attempt: number;
  preferences: DevicePreferences;
  working: boolean;
  timer?: ReturnType<typeof setTimeout>;
  candidate?: DeviceSession;
}
const connectionFailure = (error: unknown): boolean =>
  ["connection", "timeout", "protocol"].includes(normalizeDeviceError(error).category);

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
  readonly #subscriptions = new Map<string, () => void>();
  readonly #deployments = new Map<string, Deployment>();
  readonly #recoveries = new Map<string, Recovery>();
  readonly #recovered = new Map<string, string>();
  private generation = 0;
  get busy(): boolean {
    return this.#busy.size > 0 || [...this.#recoveries.values()].some((item) => item.working);
  }
  readonly #usb = new UsbTransport();
  readonly #wifi = new WiFiTransport();
  private batches: FileBatchManager | undefined;
  private batchOwners = new WeakSet<WebContents>();

  constructor(
    private readonly builds: BuildService,
    private readonly renderer: () => WebContents | undefined,
    private readonly preferences = new DevicePreferencesStore(),
  ) {}

  getPreferences = (): DevicePreferences => this.preferences.get();
  setPreferences(patch: Partial<DevicePreferences>): Promise<DevicePreferences> {
    return this.preferences.set(patch, (next) => {
      if (!next.usbAutoReconnect)
        for (const recovery of this.#recoveries.values()) this.cancelRecovery(recovery);
    });
  }

  private wifiOptions() {
    const value = this.getPreferences();
    return {
      connectTimeoutMs: value.wifiConnectTimeout,
      handshakeTimeoutMs: value.wifiHandshakeTimeout,
    };
  }

  async discover(signal = new AbortController().signal): Promise<DeviceDescriptor[]> {
    const settled = await Promise.allSettled([
      this.#usb.discover(signal),
      this.#wifi.discover(signal),
    ]);
    return mergeDiscoveryResults(settled);
  }

  connect(descriptor: DeviceDescriptor, signal = new AbortController().signal): Promise<string> {
    const options = this.wifiOptions();
    return this.connectWith(
      () =>
        descriptor.transport === "usb"
          ? this.#usb.connect(descriptor, signal)
          : this.#wifi.connect(descriptor, signal, options),
      descriptor.transport,
    );
  }

  connectWifi(address: string, signal = new AbortController().signal): Promise<string> {
    const descriptor: DeviceDescriptor = {
      id: `wifi:${address}`,
      name: `EV3 ${address}`,
      transport: "wifi",
      address,
    };
    const options = this.wifiOptions();
    return this.connectWith(() => this.#wifi.connect(descriptor, signal, options), "wifi");
  }

  async disconnect(id: string): Promise<void> {
    // Follow completed recoveries too: cancellation IPC may arrive just after
    // the replacement session was published.
    while (this.#recovered.has(id)) id = this.#recovered.get(id)!;
    const recovery = this.#recoveries.get(id);
    if (recovery) this.cancelRecovery(recovery);
    const session = this.#sessions.get(id);
    this.#subscriptions.get(id)?.();
    this.#subscriptions.delete(id);
    this.#sessions.delete(id);
    this.#deployments.delete(id);
    this.#busy.get(id)?.abort();
    await session?.disconnect().catch(() => {});
    this.send({ type: "state", state: "disconnected", sessionId: id });
  }

  async reset(): Promise<void> {
    this.generation++;
    for (const recovery of this.#recoveries.values()) this.cancelRecovery(recovery);
    const ids = [...this.#sessions.keys()];
    this.#recovered.clear();
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  upload(id: string, buildId: string, remotePath: string): Promise<void> {
    return this.operation(id, async (session, signal) => {
      this.#deployments.delete(id);
      await session.upload(remotePath, await this.builds.artifactBytes(buildId), signal);
    });
  }

  deploy(id: string, buildId: string, remoteDirectory: string): Promise<void> {
    return this.operation(id, async (session, signal) => {
      this.#deployments.delete(id);
      const deployment: Deployment = { buildId, files: [] };
      const files = await this.builds.deployableArtifacts(buildId);
      for (const file of deploymentTargets(files, remoteDirectory)) {
        try {
          const bytes = await readFile(file.path);
          signal.throwIfAborted();
          await session.upload(file.remotePath, bytes, signal);
          deployment.files.push({
            path: file.remotePath,
            size: bytes.length,
            checksum: createHash("md5").update(bytes).digest("hex"),
          });
        } catch (error) {
          const normalized = normalizeDeviceError(error, "transfer");
          throw new DeviceOperationError(
            normalized.category,
            `Unable to deploy '${file.remotePath}': ${error instanceof Error ? error.message : String(error)}`,
            normalized.recoverable,
            { cause: error },
          );
        }
      }
      signal.throwIfAborted();
      if (this.#sessions.get(id) === session) this.#deployments.set(id, deployment);
    });
  }

  run(id: string, remotePath: string): Promise<void> {
    return this.operation(id, (session, signal) => session.run(remotePath, signal));
  }

  stop(id: string): Promise<void> {
    return this.operation(id, (session, signal) => session.stop(undefined, signal));
  }

  delete(id: string, remotePath: string): Promise<void> {
    return this.operation(id, (session, signal) => {
      this.invalidateDeployment(id, [remotePath]);
      return session.delete(remotePath, signal);
    });
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
    const reset = this.reset();
    const generation = this.generation;
    await reset;
    if (generation !== this.generation)
      throw new DeviceOperationError("cancelled", "Connection cancelled.");
    this.send({ type: "state", state: "connecting", transport });
    try {
      const session = await connect();
      if (generation !== this.generation || !session.connected) {
        await session.disconnect().catch(() => {});
        throw new DeviceOperationError("cancelled", "Connection cancelled.");
      }
      const id = this.register(session);
      this.send({ type: "state", state: "connected", sessionId: id, transport });
      return id;
    } catch (error) {
      if (generation === this.generation) this.report(error);
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
    let aborted!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
    });
    this.send({
      type: "state",
      state: "busy",
      sessionId: id,
      transport: session.descriptor.transport,
    });
    try {
      const result = await Promise.race([work(session, controller.signal), cancelled]);
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
      if (connectionFailure(normalized)) await this.lost(id, session, normalized);
      throw normalized;
    } finally {
      controller.signal.removeEventListener("abort", aborted);
      this.#busy.delete(id);
    }
  }

  private register(session: DeviceSession): string {
    const id = randomUUID();
    this.#sessions.set(id, session);
    const unsubscribe = session.onDisconnect?.((error) => {
      void this.lost(id, session, error);
    });
    if (unsubscribe) this.#subscriptions.set(id, unsubscribe);
    return id;
  }

  private async lost(id: string, session: DeviceSession, error: Error): Promise<void> {
    if (this.#sessions.get(id) !== session) return;
    this.#sessions.delete(id);
    this.#subscriptions.get(id)?.();
    this.#subscriptions.delete(id);
    const deployment = this.#deployments.get(id);
    this.#deployments.delete(id);
    this.#busy.get(id)?.abort(error);
    let recovery: Recovery | undefined;
    if (session.descriptor.transport === "usb") {
      if (this.getPreferences().usbAutoReconnect && session.descriptor.serialNumber?.trim()) {
        recovery = {
          id,
          descriptor: session.descriptor,
          deployment,
          controller: new AbortController(),
          attempt: 0,
          preferences: this.getPreferences(),
          working: false,
        };
        this.#recoveries.set(id, recovery);
        this.recoveryEvent(recovery, "waiting");
      } else {
        this.send({
          type: "usb-recovery",
          state: "unavailable",
          previousSessionId: id,
          descriptor: session.descriptor,
        });
      }
    } else {
      this.send({ type: "state", state: "disconnected", sessionId: id, message: error.message });
    }
    await session.disconnect().catch(() => {});
    if (recovery) void this.recover(recovery);
  }

  private recoveryEvent(
    recovery: Recovery,
    state: "waiting" | "connecting" | "cancelled" | "unavailable" | "exhausted",
  ): void {
    this.send({
      type: "usb-recovery",
      state,
      previousSessionId: recovery.id,
      descriptor: recovery.descriptor,
    });
  }

  private cancelRecovery(recovery: Recovery, unavailable = false): void {
    this.#recoveries.delete(recovery.id);
    clearTimeout(recovery.timer);
    recovery.controller.abort();
    void recovery.candidate?.disconnect().catch(() => {});
    this.recoveryEvent(recovery, unavailable ? "unavailable" : "cancelled");
  }

  private async recover(recovery: Recovery): Promise<void> {
    const current = () => this.#recoveries.get(recovery.id) === recovery;
    if (!current()) return;
    recovery.working = true;
    recovery.attempt++;
    const signal = recovery.controller.signal;
    let candidate: DeviceSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let transferred = false;
    try {
      const devices = await this.#usb.discover(signal);
      if (!current()) return;
      const matches = devices.filter(
        (item) => item.serialNumber?.trim() === recovery.descriptor.serialNumber?.trim(),
      );
      if (matches.length > 1) {
        this.cancelRecovery(recovery, true);
        return;
      }
      if (!matches.length) return;
      if (!matches[0]!.metadata?.path) {
        this.cancelRecovery(recovery, true);
        return;
      }
      this.recoveryEvent(recovery, "connecting");
      candidate = await this.#usb.connect(matches[0]!, signal);
      recovery.candidate = candidate;
      if (!current()) return;
      let failure: Error | undefined;
      unsubscribe = candidate.onDisconnect?.((error) => {
        failure = error;
      });
      let verified = false;
      try {
        // A read-only round trip verifies the replacement handle even when no
        // uploaded version is available. Never send run/stop during recovery.
        const root = await candidate.list(REMOTE_PROJECT_ROOT, signal);
        if (recovery.deployment) {
          const listings = new Map<string, RemoteEntry[]>([[REMOTE_PROJECT_ROOT, root]]);
          verified = true;
          for (const file of recovery.deployment.files) {
            const directory = path.posix.dirname(file.path);
            if (!listings.has(directory))
              listings.set(directory, await candidate.list(directory, signal));
            const entry = listings.get(directory)!.find((item) => item.path === file.path);
            if (
              entry?.kind !== "file" ||
              entry.size !== file.size ||
              entry.checksum?.toLowerCase() !== file.checksum
            ) {
              verified = false;
              break;
            }
          }
        }
      } catch (error) {
        if (connectionFailure(error)) throw error;
        verified = false;
      }
      if (failure) throw failure;
      if (!candidate.connected)
        throw new DeviceOperationError("connection", "USB connection lost.");
      if (!current()) return;
      unsubscribe?.();
      unsubscribe = undefined;
      const id = this.register(candidate);
      transferred = true;
      this.#recoveries.delete(recovery.id);
      this.#recovered.set(recovery.id, id);
      if (verified && recovery.deployment) this.#deployments.set(id, recovery.deployment);
      this.send({
        type: "usb-recovery",
        state: "restored",
        previousSessionId: recovery.id,
        sessionId: id,
        descriptor: candidate.descriptor,
        deployment: recovery.deployment ? (verified ? "verified" : "changed") : "none",
        ...(verified && recovery.deployment ? { buildId: recovery.deployment.buildId } : {}),
      });
    } catch {
      // Keep waiting quietly. Permission/open failures can be transient while
      // the OS is still enumerating a reinserted device.
    } finally {
      unsubscribe?.();
      if (!transferred) await candidate?.disconnect().catch(() => {});
      delete recovery.candidate;
      recovery.working = false;
      if (current()) {
        const { usbRetryLimit, usbRetryInterval } = recovery.preferences;
        if (usbRetryLimit !== "unlimited" && recovery.attempt >= usbRetryLimit) {
          this.#recoveries.delete(recovery.id);
          recovery.controller.abort();
          this.recoveryEvent(recovery, "exhausted");
        } else {
          this.recoveryEvent(recovery, "waiting");
          const delay =
            usbRetryInterval === "backoff"
              ? [1000, 2000, 5000][Math.min(recovery.attempt - 1, 2)]!
              : usbRetryInterval;
          recovery.timer = setTimeout(() => void this.recover(recovery), delay);
          recovery.timer.unref?.();
        }
      }
    }
  }

  private invalidateDeployment(id: string, paths: string[]): void {
    const deployment = this.#deployments.get(id);
    if (
      deployment?.files.some((file) =>
        paths.some(
          (target) =>
            file.path === target ||
            file.path.startsWith(`${target}/`) ||
            target.startsWith(`${path.posix.dirname(file.path)}/`),
        ),
      )
    )
      this.#deployments.delete(id);
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
    if (event.type === "files-changed") this.invalidateDeployment(event.sessionId, event.paths);
    const renderer = this.renderer();
    if (renderer && !renderer.isDestroyed?.()) renderer.send("device:event", event);
  }
}
