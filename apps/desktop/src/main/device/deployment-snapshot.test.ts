import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Principal } from "@kobrixa/plugin-runtime";
import type {
  DeviceBrokerPort,
  LegacyOperation,
  LegacyOperationPort,
} from "../device-broker/broker-port.js";
import { LegacyDevice } from "../device-broker/legacy-device.js";
import { LegacyFiles } from "../device-broker/legacy-files.js";
import { DeviceService } from "./device.js";
import type { BuildService } from "../workspace/build.js";
import type { DevicePreferencesStore } from "./preferences.js";
function fixture(skipUnchangedAssets = false) {
  const principal: Principal = {
    kind: "core",
    adapter: "deployment",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: { ref: randomUUID(), epoch: randomUUID() },
  };
  const execute = vi.fn<LegacyOperation["execute"]>(async (request) => ({
    value:
      request.kind === "list"
        ? { kind: "entries", entries: [] }
        : request.kind === "run"
          ? { kind: "launch", sent: true }
          : { kind: "transfer", transferred: request.kind === "upload" ? request.size : 0 },
    dispatch: "sent",
    stopConfirmation: "not-required",
    error: null,
  }));
  const operation: LegacyOperation = {
    operationId: randomUUID(),
    execute,
    renewConfirmation() {},
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const begin = vi.fn<LegacyOperationPort["begin"]>(async () => operation);
  const request = vi.fn(
    async (_principal: Principal, _method: string, _params: unknown, _signal: AbortSignal) => ({
      ok: true,
      value: { candidates: [] },
    }),
  );
  const stop = vi.fn(async () => {}),
    disconnect = vi.fn(async () => {});
  const legacy = new LegacyDevice({
    broker: { request } as unknown as DeviceBrokerPort,
    principal: () => principal,
    stop,
    disconnect,
    feed: { subscribe: async () => async () => {} },
  });
  const artifacts = vi.fn(async () => [
    { path: "/asset", remotePath: "asset.rgf", role: "deploy-asset", bytes: Uint8Array.of(1) },
    { path: "/main", remotePath: "main.rbf", role: "deploy-main", bytes: Uint8Array.of(2) },
  ]);
  const builds = {
    artifactBytes: async () => Uint8Array.of(1),
    deployableArtifacts: artifacts,
  } as unknown as BuildService;
  const preferences = {
    get: () => ({ skipUnchangedAssets }),
    set: async () => ({}),
  } as unknown as DevicePreferencesStore;
  const service = new DeviceService(builds, () => undefined, preferences, {
    device: legacy,
    files: new LegacyFiles({ begin }, () => principal),
  });
  return { service, execute, begin, operation, request, stop, disconnect, artifacts, principal };
}
it("F14 rejects a changed immutable build before upload and preserves asset-before-main order", async () => {
  const f = fixture();
  f.artifacts.mockRejectedValueOnce(new Error("BUILD1006"));
  await expect(f.service.deploy("s", "build", "/home/root/lms2012/prjs/demo")).rejects.toThrow(
    "BUILD1006",
  );
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.service.busy).toBe(false);
  await f.service.deploy("s", "build", "/home/root/lms2012/prjs/demo");
  expect(f.execute.mock.calls.map(([value]) => value.remotePath)).toEqual([
    "/home/root/lms2012/prjs/demo/asset.rgf",
    "/home/root/lms2012/prjs/demo/main.rbf",
  ]);
});
it("T5fix missing checksum listing falls back to both artifact uploads", async () => {
  const f = fixture(true);
  f.execute.mockRejectedValueOnce(new Error("Missing directory"));
  await expect(f.service.deploy("s", "build", "/project")).resolves.toBeUndefined();
  expect(f.execute.mock.calls.map(([request]) => request.kind)).toEqual([
    "list",
    "upload",
    "upload",
  ]);
  expect(f.operation.cancel).not.toHaveBeenCalled();
});
it("T5fix deployment errors retain the failing artifact path", async () => {
  const f = fixture();
  f.execute.mockRejectedValueOnce(new Error("transfer failed"));
  await expect(f.service.deploy("s", "build", "/project")).rejects.toThrow(
    "Unable to deploy '/asset': transfer failed",
  );
});
it.each(["authority-changed", "connection-lost", "cancelled"] as const)(
  "T5fix %s listing errors never admit fallback uploads",
  async (reason) => {
    const f = fixture(true);
    f.execute.mockResolvedValueOnce({
      value: null,
      dispatch: "sent",
      stopConfirmation: "not-required",
      error: { reason, message: reason },
    });
    await expect(f.service.deploy("s", "build", "/project")).rejects.toThrow(reason);
    expect(f.execute).toHaveBeenCalledOnce();
  },
);
it("T5fix native connection errors never trigger deployment upload fallback", async () => {
  const f = fixture(true);
  f.execute.mockRejectedValueOnce(Object.assign(new Error("socket lost"), { code: "ECONNRESET" }));
  await expect(f.service.deploy("s", "build", "/project")).rejects.toMatchObject({
    category: "connection",
  });
  expect(f.execute).toHaveBeenCalledOnce();
});
it("T5fix unavailable checksum capability falls back to uploading", async () => {
  const f = fixture(true);
  f.execute.mockResolvedValueOnce({
    value: null,
    dispatch: "not-sent",
    stopConfirmation: "not-required",
    error: { reason: "unsupported-capability", message: "Checksums unavailable" },
  });
  await expect(f.service.deploy("s", "build", "/project")).resolves.toBeUndefined();
  expect(f.execute.mock.calls.map(([request]) => request.kind)).toEqual([
    "list",
    "upload",
    "upload",
  ]);
});
