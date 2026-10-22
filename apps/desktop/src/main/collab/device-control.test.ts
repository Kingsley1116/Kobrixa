import { expect, it, vi } from "vitest";
import { AuthorityContexts } from "../device-broker/authority-context.js";
import {
  DeviceControlGate,
  DEVICE_CONTROL_DENIED,
  registerDeviceControlIpc,
} from "./device-control.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
function fixture() {
  const contexts = new AuthorityContexts(id(1));
  const gate = new DeviceControlGate(contexts);
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  const sender = { id: 7, once: vi.fn((name: string, fn: () => void) => callbacks.set(name, fn)) };
  const document = gate.open(sender as never).document;
  let sequence = 0;
  const report = (isHolder: boolean, state: "local" | "room" = "room") =>
    gate.set(sender as never, {
      document,
      sequence: ++sequence,
      state,
      roomId: state === "local" ? null : "room",
      connected: true,
      synced: true,
      role: state === "local" ? null : "host",
      isHolder,
    });
  return { gate, sender, report, callbacks };
}
it("opening an early recovery workbench establishes identity without granting device writes", () => {
  const contexts = new AuthorityContexts(id(1));
  const gate = new DeviceControlGate(contexts);
  const sender = { id: 17, once: vi.fn() };
  const document = gate.open(sender).document;
  const principal = gate.principal(sender.id, "recovery");
  expect(principal.kind).toBe("core");
  expect(principal.authorityContext).not.toBeNull();
  expect(gate.open(sender).document).toBe(document);
  expect(gate.principal(sender.id, "recovery")).toEqual(principal);
  expect(() => contexts.assertContinuation(principal, principal.authorityContext!.ref)).toThrow(
    "unbound",
  );
  expect(() => gate.assert(sender.id, "device:run", [])).toThrow(DEVICE_CONTROL_DENIED);
  gate.invalidate(sender.id);
  gate.open(sender);
  expect(gate.principal(sender.id, "recovery")).not.toEqual(principal);
  expect(() => contexts.assertContinuation(principal, principal.authorityContext!.ref)).toThrow(
    "authority-changed",
  );
});
it("F03 denies missing reports and F14 preserves reads and stop after revoke", () => {
  const f = fixture();
  for (const sender of [7, 99])
    expect(() => f.gate.assert(sender, "device:run", [])).toThrow(DEVICE_CONTROL_DENIED);
  f.report(true, "local");
  expect(() => f.gate.assert(7, "device:run", [])).not.toThrow();
  f.report(false);
  for (const name of [
    "device:upload",
    "device:deploy",
    "device:run",
    "device:delete",
    "device:motor-test-start",
    "device:motor-test-keepalive",
    "device:set-input-mode",
  ])
    expect(() => f.gate.assert(7, name, [])).toThrow(DEVICE_CONTROL_DENIED);
  for (const name of [
    "device:monitor",
    "device:input-modes",
    "device:stop",
    "device:motor-test-stop",
    "device:files-stop",
  ])
    expect(() => f.gate.assert(7, name, [])).not.toThrow();
  for (const action of ["list", "download"])
    expect(() => f.gate.assert(7, "device:files", [{ action }])).not.toThrow();
});
it("F14 only admits a download plan remembered from the service", () => {
  const f = fixture();
  const ref = { sessionId: id(2), requestId: id(3), planId: id(4) };
  f.report(false);
  expect(() =>
    f.gate.assert(7, "device:files-execute", [{ ...ref, action: "download" }]),
  ).toThrow();
  f.gate.rememberBatch(f.sender as never, { ...ref, action: "download" });
  expect(() => f.gate.assert(7, "device:files-execute", [ref])).not.toThrow();
  expect(() => f.gate.assert(8, "device:files-execute", [ref])).toThrow();
  f.callbacks.get("destroyed")!();
  expect(() => f.gate.assert(7, "device:files-execute", [ref])).toThrow();
  expect(() => f.gate.assert(7, "device:run", [])).toThrow();
});
it("reports synchronously and awaits stop only after revocation", async () => {
  const f = fixture();
  f.report(true, "local");
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const stop = vi.fn(async () => {
    expect(() => f.gate.assert(7, "device:run", [])).toThrow();
  });
  registerDeviceControlIpc(
    ((name: string, action: (...args: unknown[]) => unknown) =>
      handlers.set(name, action)) as never,
    f.gate,
    stop,
  );
  const document = f.gate.open(f.sender as never).document;
  await handlers.get("collab:set-device-control")!(
    { sender: f.sender },
    {
      document,
      sequence: 2,
      state: "room",
      roomId: "room",
      connected: true,
      synced: true,
      role: "viewer",
      isHolder: false,
    },
  );
  expect(stop).toHaveBeenCalledOnce();
});
