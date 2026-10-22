// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { fixture, entry, handle, binding, snapshot } from "./contract.test.js";
import { RendererSession } from "./bootstrap.js";
import { PluginStatusHost } from "./status-host.js";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("shows validated initial status before process activation without inventing a binding", async () => {
  const f = fixture(); const status = { ...entry, id: "acme.ui.status", kind: "status" as const };
  f.bridge.catalog.mockResolvedValue({ ok: true, value: { hostEpoch: handle(1), revision: 1, entries: [status], nextCursor: null } });
  f.bridge.resource.mockResolvedValue({ ok: true, value: {
    owner: status, id: status.id, version: 1, validationContext: { pluginId: "acme.ui", commands: [], panels: [] }, rawBytes: 200,
    resource: { kind: "status", text: { ref: { scope: "data", key: "text" } }, tone: "neutral", data: {
      text: { schema: { type: "string", maxLength: 32, nullable: false }, initial: "Not started" },
    } },
  } });
  const session = new RendererSession(f.bridge); await session.start();
  const div = document.createElement("div"); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(PluginStatusHost, { session, locale: "en", labels })));
    expect(div.textContent).toContain("Not started");
    expect(session.record(status)).toBeUndefined();
    expect(f.bridge.open).not.toHaveBeenCalled();
    expect(f.bridge.invoke).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); session.dispose(); }
});
it("U01/U15 shows replayed current status text without spawning and exposes no feature actions", async () => {
  const f = fixture(); const status = { ...entry, id: "acme.ui.status", kind: "status" as const };
  f.bridge.catalog.mockResolvedValue({ ok: true, value: { hostEpoch: handle(1), revision: 1, entries: [status], nextCursor: null } });
  f.bridge.resource.mockResolvedValue({ ok: true, value: { owner: status, id: status.id, version: 1, validationContext: { pluginId: "acme.ui", commands: [], panels: [] }, rawBytes: 200, resource: { kind: "status", text: { text: { en: "Stopped" } }, tone: "success", data: {} } } });
  const statusBinding = { ...binding, contributionId: status.id, kind: "status" as const };
  f.bridge.snapshot.mockResolvedValue({ ok: true, value: { ...snapshot(), binding: statusBinding, data: {}, form: {} } });
  f.bridge.onEvent.mockImplementation((listener) => {
    f.listeners.add(listener); listener({ type: "state", binding: statusBinding, revision: 0 });
    return () => { f.listeners.delete(listener); };
  });
  const session = new RendererSession(f.bridge); await session.start();
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(createElement(PluginStatusHost, { session, locale: "en", labels })));
  expect(div.textContent).toContain("Stopped"); expect(div.querySelector("button")).toBeNull();
  expect(f.bridge.open).not.toHaveBeenCalled(); expect(f.bridge.invoke).not.toHaveBeenCalled();
  await act(async () => root.unmount()); session.dispose(); div.remove();
});

it.each([false, true])("quarantines rejected status resources only while live (unmounted=%s)", async (unmounted) => {
  const f = fixture(); const status = { ...entry, kind: "status" as const };
  f.bridge.catalog.mockResolvedValue({ ok: true, value: { hostEpoch: handle(1), revision: 1, entries: [status], nextCursor: null } });
  const session = new RendererSession(f.bridge); await session.start();
  let reject!: (error: Error) => void;
  vi.spyOn(session.catalog, "resource").mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const quarantine = vi.spyOn(session, "quarantine");
  const div = document.createElement("div"); const root = createRoot(div);
  await act(async () => root.render(createElement(PluginStatusHost, { session, locale: "en", labels })));
  if (unmounted) await act(async () => root.unmount());
  await act(async () => { reject(new Error("resource failed")); });
  if (unmounted) expect(quarantine).not.toHaveBeenCalled();
  else { expect(quarantine).toHaveBeenCalledWith(status, "renderer"); await act(async () => root.unmount()); }
  session.dispose(); vi.restoreAllMocks();
});
