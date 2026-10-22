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
function fixture() {
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
    get: () => ({ skipUnchangedAssets: false }),
    set: async () => ({}),
  } as unknown as DevicePreferencesStore;
  const service = new DeviceService(builds, () => undefined, preferences, {
    device: legacy,
    files: new LegacyFiles({ begin }, () => principal),
  });
  return { service, execute, begin, operation, request, stop, disconnect, artifacts, principal };
}
it("F07 one-shot monitor enters devices/session/read, never a raw transport", async () => {
  const f = fixture();
  f.request.mockResolvedValue({ ok: false, error: { message: "foreground" } } as never);
  expect((await f.service.monitor("s")).status).toBe("error");
  expect(f.request).toHaveBeenCalledWith(
    f.principal,
    "devices/session",
    { sessionId: "s" },
    expect.any(AbortSignal),
  );
  expect(f.begin).not.toHaveBeenCalled();
});
