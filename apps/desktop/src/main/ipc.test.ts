import type { Principal as ImportedPrincipal, CoreActionReference as ImportedCoreActionReference } from "@kobrixa/plugin-runtime";
import type { AuthorityPort as ImportedAuthorityPort } from "./device-broker/authority-port.js";
import type { CorePrincipal as ImportedCorePrincipal } from "./device-broker/broker-port.js";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
const fileDialog = vi.hoisted(() => ({ showOpenDialog: vi.fn() }));
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: { handle: (key: string, fn: (...args: unknown[]) => unknown) => handlers.set(key, fn) }, shell: {}, dialog: fileDialog }));
import { registerIpc } from "./ipc.js";
import { DeviceControlGate } from "./collab/device-control.js";
import { AuthorityContexts } from "./device-broker/authority-context.js";
import { UpdateOperationGate } from "./updates/service.js";
import { trustedDeviceActions, createLegacyActionAdmission } from "./plugins/controller.js";
import { createLegacyDevice } from "./device-broker/legacy-device.js";
import { createCoreActionLedger } from "./plugins/core-recovery.js";
import type { DeviceBrokerPort } from "./device-broker/broker-port.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
beforeEach(() => handlers.clear());
function fixture() {
  const renderer = { id: 7, mainFrame: {}, once: vi.fn() };
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const authority = new DeviceControlGate(new AuthorityContexts(id(1)));
  const disconnect = vi.fn(async (_session: string, _principal: ImportedPrincipal) => {}), stop = vi.fn(async (_session: string, _principal: ImportedPrincipal) => {}), beforeClose = vi.fn(async () => {}), finish = vi.fn();
  const motors = { flush: vi.fn(async () => {}) }, lab = { flush: vi.fn(async () => {}) };
  registerIpc(() => renderer as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, new UpdateOperationGate(() => undefined), finish, undefined,
    { monitor: {} as never, lab: lab as never, motors: motors as never }, [], undefined, undefined,
    { authority, disconnect, stop, beforeClose });
  return { renderer, event, authority, disconnect, stop, beforeClose, finish, motors, lab,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) };
}
it("BM-04 principal derivation belongs to DeviceControlGate, not AuthorityPort", () => {
  const contexts = new AuthorityContexts(id(1));
  const authority: ImportedAuthorityPort = contexts;
  const gate = new DeviceControlGate(contexts);
  expect(gate.contexts).toBe(authority);
  expectTypeOf<typeof gate.principal>().parameters.toEqualTypeOf<[number, ImportedCorePrincipal["adapter"]]>();
  expectTypeOf<Extract<"principal", keyof typeof authority>>().toEqualTypeOf<never>();
});
it("F02 rejects foreign/subframe senders before deriving any principal", async () => {
  const f = fixture();
  for (const event of [{ ...f.event, sender: { ...f.renderer, id: 8 } }, { ...f.event, senderFrame: {} }])
    expect(() => handlers.get("collab:device-control-context")!(event)).toThrow("untrusted");
  expect(f.disconnect).not.toHaveBeenCalled();
});
it("F03 report needs the main-issued document and cannot carry an owner or scope", async () => {
  const f = fixture(); const context = f.call("collab:device-control-context") as { document: string };
  const report = { document: context.document, sequence: 1, state: "local", roomId: null,
    connected: true, synced: true, role: null, isHolder: true };
  await expect(f.call("collab:set-device-control", { ...report, owner: {}, hostEpoch: id(5) })).rejects.toThrow();
  await f.call("collab:set-device-control", report);
  await f.call("device:disconnect", id(2));
  expect(f.disconnect).toHaveBeenCalledWith(id(2), expect.objectContaining({ kind: "core", adapter: "recovery", hostEpoch: id(1) }));
});
it("F17 renderer flush success cannot skip legacy or foundation save blockers", async () => {
  const f = fixture(); f.lab.flush.mockRejectedValueOnce(new Error("legacy disk full"));
  await expect(f.call("workspace:finish-close", id(2), true)).rejects.toThrow("disk full");
  expect(f.finish).not.toHaveBeenCalled();
  f.beforeClose.mockRejectedValueOnce(new Error("journal unconfirmed"));
  await expect(f.call("workspace:finish-close", id(2), true)).rejects.toThrow("journal");
  expect(f.finish).not.toHaveBeenCalled();
  await f.call("workspace:finish-close", id(2), true);
  expect(f.finish).toHaveBeenCalledWith(id(2), true);
});
it("BM-04 sender admission precedes one mint/claim/complete and retry uses a fresh token", async () => {
  const f = fixture();
  const issued = f.call("collab:device-control-context") as { document: string };
  await f.call("collab:set-device-control", { document: issued.document, sequence: 1, state: "local",
    roomId: null, connected: true, synced: true, role: null, isHolder: true });
  const principal = f.authority.principal(f.renderer.id, "recovery");
  if (principal.kind !== "core") throw new Error("Expected core principal");
  const ledger = createCoreActionLedger({ now: () => 0,
    current: scope => scope.hostEpoch === principal.hostEpoch && scope.workbenchInstance === principal.workbenchInstance });
  const mint = vi.spyOn(ledger, "mint"), claim = vi.spyOn(ledger, "claim"), complete = vi.spyOn(ledger, "complete");
  const broker = { stopCurrentDevice: vi.fn<DeviceBrokerPort["stopCurrentDevice"]>(async ({ sessionId, action }) => {
    expect(ledger.claim(action, { kind: "device-current-stop", sessionId })).toBe(true);
    return { ok: true, value: { revision: 0, journalHealth: "ready", faults: [], blockers: [] } };
  }) };
  let fail = true;
  const coordinator = { async disconnect(sessionId: string, action: ImportedCoreActionReference) {
    expect(ledger.claim(action, { kind: "device-disconnect", sessionId })).toBe(true);
    if (fail) throw new Error("journal blocked");
  } };
  const callbacks = trustedDeviceActions(broker, coordinator, ledger);
  const admission = createLegacyActionAdmission(callbacks);
  const legacy = createLegacyDevice({ broker: broker as unknown as DeviceBrokerPort, principal: () => principal,
    feed: {} as Parameters<typeof createLegacyDevice>[0]["feed"],
    stop: admission.stop, disconnect: admission.disconnect });
  const admitted = admission.bind(legacy);
  f.stop.mockImplementation(admitted.stop);
  f.disconnect.mockImplementation(admitted.disconnect);
  // Model each non-IPC entry without handing it the private admitted wrapper.
  const timer = () => legacy.stop(id(2));
  const ready = () => legacy.disconnect(id(2));
  const deviceServiceEvent = () => legacy.stop(id(2));
  for (const callback of [timer, ready, deviceServiceEvent])
    await expect(Promise.resolve().then(callback)).rejects.toThrow("Validated device IPC required");
  expect(broker.stopCurrentDevice).not.toHaveBeenCalled();
  expect(mint).not.toHaveBeenCalled();
  expect(() => handlers.get("device:stop")!({ ...f.event, senderFrame: {} }, id(2))).toThrow("untrusted");
  expect(mint).not.toHaveBeenCalled();
  await f.call("device:stop", id(2));
  expect(mint).toHaveBeenCalledTimes(1); expect(claim).toHaveBeenCalledTimes(1); expect(complete).toHaveBeenCalledTimes(1);
  expect(mint.mock.calls[0]![1]).toEqual({ kind: "device-current-stop", sessionId: id(2) });
  await expect(f.call("device:disconnect", id(2))).rejects.toThrow("journal blocked");
  fail = false; await f.call("device:disconnect", id(2));
  expect(mint).toHaveBeenCalledTimes(3); expect(claim).toHaveBeenCalledTimes(3); expect(complete).toHaveBeenCalledTimes(3);
  expect(new Set(mint.mock.results.map(result => result.value.actionToken)).size).toBe(3);
  await expect(legacy.stop(id(2))).rejects.toThrow("Validated device IPC required");
  await expect(legacy.disconnect(id(2))).rejects.toThrow("Validated device IPC required");
  expect(mint).toHaveBeenCalledTimes(3);
});


import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceService } from "./device/device.js";
import { LegacyFiles } from "./device-broker/legacy-files.js";
import type { LegacyOperation } from "./device-broker/broker-port.js";
afterEach(() => vi.useRealTimers());
async function renewalFixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const root = await mkdtemp(join(tmpdir(), "kobrixa-renew-"));
  const file = join(root, "sample.rbf"); await writeFile(file, "test");
  fileDialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [file] });
  const renderer = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => false, send: vi.fn() });
  const authority = new DeviceControlGate(new AuthorityContexts(id(1)));
  const original = authority.open(renderer as never);
  const report = { document: original.document, sequence: 1, state: "local", roomId: null,
    connected: true, synced: true, role: null, isHolder: true };
  authority.set(renderer as never, report);
  const principal = () => authority.principal(renderer.id, "recovery");
  const operation: LegacyOperation = { operationId: id(9),
    execute: vi.fn(async () => ({ value: { kind: "entries" as const, entries: [] }, dispatch: "sent" as const,
      stopConfirmation: "not-required" as const, error: null })),
    renewConfirmation: vi.fn(), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
  const legacy = createLegacyDevice({ broker: {} as DeviceBrokerPort, principal, feed: {} as never,
    stop: async () => {}, disconnect: async () => {} });
  const files = new LegacyFiles({ begin: async () => operation }, () => ({ ...principal(), adapter: "remote-files" }) as ImportedCorePrincipal);
  const devices = new DeviceService({} as never, () => renderer as never, undefined, { device: legacy, files });
  registerIpc(() => renderer as never, {} as never, {} as never, {} as never, devices, {} as never,
    new UpdateOperationGate(() => undefined), undefined, undefined, undefined, [], undefined, undefined,
    { authority, stop: async () => {}, disconnect: async () => {}, beforeClose: async () => {} });
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args);
  const plan = await devices.prepareFiles({ sessionId: id(2), requestId: id(3), action: "upload",
    path: "/home/root/lms2012/prjs", paths: [], source: "files", locale: "en" }, renderer as never);
  expect(plan.phase).toBe("ready");
  vi.mocked(operation.renewConfirmation).mockClear();
  const ref = { sessionId: plan.sessionId, requestId: plan.requestId, planId: plan.planId };
  return { authority, renderer, event, report, operation, call, ref, devices,
    cleanup: async () => { await devices.stopFiles(ref, renderer.id).catch(() => {}); await rm(root, { recursive: true, force: true }); } };
}
it("D150 renews a real retained file plan only for its original sender/ref at 119 seconds", async () => {
  const f = await renewalFixture();
  try {
    await vi.advanceTimersByTimeAsync(119000);
    for (const bad of [{ ...f.ref, planId: id(90) }, { ...f.ref, scope: {} }, { ...f.ref, actionToken: id(80) }])
      await expect(Promise.resolve().then(() => f.call("device:files-renew", bad))).rejects.toThrow();
    for (const event of [{ ...f.event, sender: { id: 8 } }, { ...f.event, senderFrame: {} }])
      expect(() => handlers.get("device:files-renew")!(event, f.ref)).toThrow("untrusted");
    expect(f.operation.renewConfirmation).not.toHaveBeenCalled();
    await f.call("device:files-renew", f.ref);
    expect(f.operation.renewConfirmation).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});
it.each(["replacement", "authority", "cancelled", "completed"])("D150 %s cannot renew a retained plan", async kind => {
  const f = await renewalFixture();
  try {
    if (kind === "replacement") { f.authority.invalidate(f.renderer.id); f.authority.open(f.renderer as never); }
    if (kind === "authority") f.authority.set(f.renderer as never, { ...f.report, sequence: 2, state: "invalid", isHolder: false });
    if (kind === "cancelled") await f.devices.stopFiles(f.ref, f.renderer.id);
    if (kind === "completed") await f.devices.executeFiles(f.ref, "skip", f.renderer.id);
    vi.mocked(f.operation.renewConfirmation).mockClear();
    await expect(Promise.resolve().then(() => f.call("device:files-renew", f.ref))).rejects.toThrow();
    expect(f.operation.renewConfirmation).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
it("D150 explicit 100/200/300/400/500 second renewals retain the original 600 second deadline", async () => {
  const f = await renewalFixture();
  try {
    for (let i = 1; i <= 5; i++) { await vi.advanceTimersByTimeAsync(100000); await f.call("device:files-renew", f.ref); }
    expect(f.operation.renewConfirmation).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(100000);
    const exchanges = vi.mocked(f.operation.execute).mock.calls.length;
    await expect(Promise.resolve().then(() => f.call("device:files-renew", f.ref))).rejects.toThrow();
    expect(f.operation.renewConfirmation).toHaveBeenCalledTimes(5);
    expect(vi.mocked(f.operation.execute).mock.calls.length).toBe(exchanges);
    expect(f.operation.cancel).toHaveBeenCalledOnce();
  } finally { await f.cleanup(); }
});
