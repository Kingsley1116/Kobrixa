// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { fixture, entry } from "./contract.test.js";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { RendererSession } from "./bootstrap.js";
import { PluginToolsPane } from "./panel-host.js";
it("U15 mounting an available tab is inert; explicit open activates once; close sends close", async () => {
  const f = fixture();
  const session = new RendererSession(f.bridge);
  await session.start();
  session.showPane(true, "sidebar");
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        {},
        createElement(PluginToolsPane, { session, locale: "en", labels, onClose: vi.fn() }),
      ),
    ),
  );
  expect(f.bridge.open).not.toHaveBeenCalled();
  const open = [...div.querySelectorAll("button")].find(
    (button) => button.textContent === labels.open,
  )!;
  await act(async () => {
    open.click();
  });
  expect(f.bridge.open).toHaveBeenCalledTimes(1);
  expect(div.querySelector('[data-ui-node="hold"]')).not.toBeNull();
  const close = [...div.querySelectorAll("button")].find(
    (button) => button.dataset.closeContribution === "true",
  )!;
  await act(async () => close.click());
  expect(session.record(entry)).toBeUndefined();
  expect(f.bridge.close).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  session.dispose();
  div.remove();
});
