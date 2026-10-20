import { expect, it } from "vitest";
import { fixture, entry } from "./contract.test.js";
import { createPluginUiRendererHost, rendererSession, diagnosticsFor } from "./host-ports.js";
it("U15 keeps one bridge subscription across view remounts and revokes before disposal", async () => {
  const f = fixture(); const host = createPluginUiRendererHost(f);
  await Promise.all([host.start(), host.start()]);
  const session = rendererSession(host); session.showPane(true, "sidebar"); await session.open(entry);
  const record = session.record(entry)!;
  const diagnostics = diagnosticsFor(host);
  expect(diagnostics.snapshot().resourceReaders).toBeGreaterThan(0);
  expect(() => diagnosticsFor({})).toThrow();
  record.intent.begin("hold", { trusted: true, kind: "key", id: "Enter", primary: true, repeat: false });
  host.dispose(); host.dispose();
  expect(Object.values(diagnostics.snapshot()).every((value) => value === 0)).toBe(true);
  expect(f.bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
  expect(f.bridge.onEvent).toHaveBeenCalledTimes(1); expect(f.listeners.size).toBe(0);
});
