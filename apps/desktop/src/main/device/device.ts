import { createHash } from "node:crypto";
import path from "node:path";
import type { WebContents } from "electron";
import {
  DeviceOperationError,
  normalizeDeviceError,
  type DeviceDescriptor,
  type RemoteEntry,
} from "@kobrixa/device";
import type { DevicePreferences } from "../../shared/device-preferences.js";
import type {
  DeviceEvent,
  FileBatchRef,
  FileBatchRequest,
  FileBatchSnapshot,
  RemoteFileRequest,
  RemoteFileResult,
} from "../../shared/api.js";
import type { BuildService } from "../workspace/build.js";
import { DevicePreferencesStore } from "./preferences.js";
import { remoteFileOperation } from "./remote-files.js";
import { FileBatchManager } from "./file-batch.js";
import type { LegacyDevice } from "../device-broker/legacy-device.js";
import type { LegacyFiles } from "../device-broker/legacy-files.js";
import type { CorePrincipal } from "../device-broker/broker-port.js";
const renewals = new Map<
  string,
  { ref: FileBatchRef; owner: CorePrincipal; current: () => CorePrincipal; renew: () => void }
>();
function sameCore(a: CorePrincipal, b: CorePrincipal): boolean {
  return (
    a.kind === b.kind &&
    a.adapter === b.adapter &&
    a.hostEpoch === b.hostEpoch &&
    a.workbenchInstance === b.workbenchInstance &&
    a.authorityContext?.ref === b.authorityContext?.ref &&
    a.authorityContext?.epoch === b.authorityContext?.epoch
  );
}
export function renewFilePlan(ref: FileBatchRef, owner: CorePrincipal): void {
  const entry = renewals.get(ref.planId);
  if (
    !entry ||
    entry.ref.sessionId !== ref.sessionId ||
    entry.ref.requestId !== ref.requestId ||
    !sameCore(entry.owner, owner) ||
    !sameCore(entry.owner, entry.current())
  )
    throw new Error("Unknown or expired file operation.");
  entry.renew(); // retained session checks state/600s deadline; broker rechecks current authority
}
export function mergeDiscoveryResults(
  settled: PromiseSettledResult<DeviceDescriptor[]>[],
): DeviceDescriptor[] {
  const devices = settled.flatMap((value) => (value.status === "fulfilled" ? value.value : []));
  if (devices.length) return devices;
  const rejected = settled.find(
    (value): value is PromiseRejectedResult => value.status === "rejected",
  );
  if (rejected) throw rejected.reason;
  return [];
}
export function deploymentTargets<T extends { path: string; remotePath: string }>(
  files: T[],
  remoteDirectory: string,
): T[] {
  return files.map((file) => {
    const relative = file.remotePath.replaceAll("\\", "/");
    if (relative.startsWith("/") || relative.split("/").some((part) => part === ".."))
      throw new DeviceOperationError("transfer", `Unsafe asset deployment path '${relative}'.`);
    return { ...file, remotePath: path.posix.join(remoteDirectory, relative) };
  });
}
export interface LegacyDeviceServices {
  device: LegacyDevice;
  files: LegacyFiles;
}
export class DeviceService {
  private listeners = new Set<(event: DeviceEvent) => void>();
  private batches: FileBatchManager | undefined;
  private batchOwners = new WeakSet<WebContents>();
  private pending = 0;
  private beforeDisconnect: ((id: string) => Promise<void>) | undefined;
  constructor(
    private builds: BuildService,
    private renderer: () => WebContents | undefined,
    private preferences = new DevicePreferencesStore(),
    private legacy?: LegacyDeviceServices,
  ) {}
  attachLegacy(services: { device: LegacyDevice; files: LegacyFiles }): void {
    if (this.legacy) throw new Error("Legacy broker already attached.");
    this.legacy = services;
  }
  private get ports(): LegacyDeviceServices {
    if (!this.legacy) throw new Error("Device broker unavailable.");
    return this.legacy;
  }
  get busy(): boolean {
    return this.pending > 0;
  }
  subscribe(listener: (event: DeviceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private send(event: DeviceEvent): void {
    const renderer = this.renderer();
    if (renderer && !renderer.isDestroyed?.()) renderer.send("device:event", event);
    for (const listener of this.listeners) listener(event);
  }
  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.pending++;
    try {
      return await work();
    } finally {
      this.pending--;
    }
  }
  descriptor(id: string): DeviceDescriptor {
    return this.ports.device.descriptor(id);
  }
  getPreferences = (): DevicePreferences => this.preferences.get();
  setPreferences(patch: Partial<DevicePreferences>): Promise<DevicePreferences> {
    return this.preferences.set(patch, () => {});
  }
  setBeforeDisconnect(stop: (id: string) => Promise<void>): void {
    this.beforeDisconnect = stop;
  }
  discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    return this.ports.device.discover(signal);
  }
  async connect(descriptor: DeviceDescriptor, signal?: AbortSignal): Promise<string> {
    return this.track(async () => {
      const id = await this.ports.device.connect(descriptor, signal);
      this.send({
        type: "state",
        state: "connected",
        sessionId: id,
        transport: descriptor.transport,
      });
      return id;
    });
  }
  reconnectForRecovery(previousSessionId: string, signal: AbortSignal): Promise<string> {
    return this.ports.device.reconnectForRecovery(previousSessionId, signal);
  }
  async connectWifi(address: string, signal?: AbortSignal): Promise<string> {
    return this.track(async () => {
      const id = await this.ports.device.connectWifi(address, signal);
      this.send({ type: "state", state: "connected", sessionId: id, transport: "wifi" });
      return id;
    });
  }
  async disconnect(id: string): Promise<void> {
    await this.beforeDisconnect?.(id);
    await this.ports.device.disconnect(id);
    this.send({ type: "state", state: "disconnected", sessionId: id });
  }
  async reset(): Promise<void> {
    await this.ports.device.reset();
  }
  monitor(id: string) {
    return this.ports.device.monitor(id);
  }
  inputModes(id: string, port: number, type: number) {
    return this.ports.device.inputModes(id, port, type);
  }
  setInputMode(id: string, port: number, type: number, mode: number) {
    return this.ports.device.setInputMode(id, port, type, mode);
  }
  upload(id: string, buildId: string, remotePath: string): Promise<void> {
    return this.track(() =>
      this.ports.files.run(
        id,
        async (session, signal) => {
          const bytes = await this.builds.artifactBytes(buildId, signal);
          signal.throwIfAborted();
          await session.upload(remotePath, bytes, signal);
        },
        "deployment",
      ),
    );
  }
  deploy(id: string, buildId: string, remoteDirectory: string): Promise<void> {
    return this.track(() =>
      this.ports.files.run(
        id,
        async (session, signal) => {
          // BuildService verifies the complete immutable snapshot before any upload.
          const files = deploymentTargets(
            await this.builds.deployableArtifacts(buildId, signal),
            remoteDirectory,
          );
          signal.throwIfAborted();
          const listings = new Map<string, RemoteEntry[]>();
          for (const file of files) {
            signal.throwIfAborted();
            const checksum = createHash("md5").update(file.bytes).digest("hex");
            let unchanged = false;
            if (this.getPreferences().skipUnchangedAssets && file.role === "deploy-asset") {
              const directory = path.posix.dirname(file.remotePath);
              if (!listings.has(directory))
                listings.set(directory, await session.list(directory, signal));
              signal.throwIfAborted();
              const entry = listings
                .get(directory)!
                .find((value) => value.path === file.remotePath);
              unchanged =
                entry?.kind === "file" &&
                entry.size === file.bytes.length &&
                entry.checksum?.toLowerCase() === checksum;
            }
            if (!unchanged) await session.upload(file.remotePath, file.bytes, signal);
          }
          signal.throwIfAborted();
        },
        "deployment",
      ),
    );
  }
  run(id: string, remotePath: string): Promise<void> {
    return this.track(() =>
      this.ports.files.run(
        id,
        (session, signal) => session.run(remotePath, signal),
        "program-launch",
      ),
    );
  }
  stop(id: string): Promise<void> {
    return this.ports.device.stop(id);
  }
  delete(id: string, remotePath: string): Promise<void> {
    return this.track(() =>
      this.ports.files.run(
        id,
        (session, signal) => session.delete(remotePath, signal),
        "file-write",
      ),
    );
  }
  async files(request: RemoteFileRequest): Promise<RemoteFileResult> {
    try {
      const { dialog } = await import("electron");
      return await this.track(() =>
        this.ports.files.run(
          request.sessionId,
          (session, signal) =>
            remoteFileOperation(
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
            ),
          request.action === "list" || request.action === "download" ? "file-read" : "file-write",
        ),
      );
    } catch (error) {
      const value = normalizeDeviceError(error);
      return {
        ok: false,
        sessionId: request.sessionId,
        requestId: request.requestId,
        category: value.category,
        message: value.message,
      };
    }
  }
  async prepareFiles(request: FileBatchRequest, owner: WebContents): Promise<FileBatchSnapshot> {
    const current = (): CorePrincipal => {
      const value = this.ports.device.dependencies.principal();
      if (value.kind !== "core") throw new Error("Core file owner required.");
      return { ...value, adapter: "remote-files" };
    };
    const original = structuredClone(current());
    const { dialog } = await import("electron");
    this.batches ??= new FileBatchManager(
      (id, work, operationClass) =>
        this.track(() => this.ports.files.run(id, work, operationClass)),
      dialog,
      (snapshot) => {
        if (snapshot.phase !== "ready") renewals.delete(snapshot.planId);
        this.send({ type: "file-batch", snapshot });
      },
      (value, paths) =>
        this.send({
          type: "files-changed",
          sessionId: value.sessionId,
          requestId: value.requestId,
          paths,
        }),
    );
    if (!this.batchOwners.has(owner)) {
      this.batchOwners.add(owner);
      const id = owner.id;
      const abandon = () => {
        this.batches?.abandonOwner(id);
        for (const [key, entry] of renewals)
          if (
            entry.owner.hostEpoch === original.hostEpoch &&
            entry.owner.workbenchInstance === original.workbenchInstance
          )
            renewals.delete(key);
      };
      owner.once("destroyed", abandon);
      owner.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) abandon();
      });
    }
    const snapshot = await this.batches.prepare(request, owner.id);
    if (snapshot.phase === "ready" && !owner.isDestroyed() && sameCore(original, current())) {
      const ref = {
        sessionId: snapshot.sessionId,
        requestId: snapshot.requestId,
        planId: snapshot.planId,
      };
      renewals.set(ref.planId, {
        ref,
        owner: original,
        current,
        renew: () => {
          this.batches!.renew(ref, owner.id);
        },
      });
    }
    return snapshot;
  }
  executeFiles(
    ref: FileBatchRef,
    policy: "skip" | "replace",
    owner: number,
  ): Promise<FileBatchSnapshot> {
    if (!this.batches) throw new Error("Unknown file operation.");
    return this.batches.execute(ref, policy, owner);
  }
  stopFiles(ref: FileBatchRef, owner: number): Promise<void> {
    if (!this.batches) throw new Error("Unknown file operation.");
    return this.batches.stop(ref, owner);
  }
  renewFilePlan(ref: FileBatchRef, owner: CorePrincipal): void {
    renewFilePlan(ref, owner);
  }
}
