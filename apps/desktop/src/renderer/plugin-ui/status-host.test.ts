// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { fixture, entry, handle, binding, snapshot } from "./contract.test.js";
import { RendererSession } from "./bootstrap.js";
import { PluginStatusHost } from "./status-host.js";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
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
