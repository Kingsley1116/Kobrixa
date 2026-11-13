// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UiCatalogEntry } from "@kobrixa/plugin-protocol";
import { UiCatalogStore } from "../plugin-ui/catalog-store.js";
import { MonitorWorkspace } from "./monitor-workspace.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const entry: UiCatalogEntry = {
  sourceKey: "builtin:kobrixa.sensor-lab",
  pluginId: "kobrixa.sensor-lab",
  id: "kobrixa.sensor-lab.panel",
  kind: "panel",
  title: { en: "Sensor Lab" },
  version: 2,
  resourceDigest: "a".repeat(64),
  resourceBytes: 200,
  uiResourceGeneration: 1,
  availability: "available",
};
for (const feature of ["device-ev3", "sensor-lab"] as const)
  for (const phase of ["available", "disabled", "unavailable", "pending"] as const)
    it(`routes ${phase} ${feature} via actual catalog without mounting private features`, async () => {
      let entries =
        phase === "disabled"
          ? []
          : [
              {
                ...entry,
                sourceKey: `builtin:kobrixa.${feature}`,
                pluginId: `kobrixa.${feature}`,
                id: `kobrixa.${feature}.panel`,
                availability:
                  phase === "unavailable" ? ("unavailable" as const) : ("available" as const),
              },
            ];
      let revision = 1;
      const resource = vi.fn();
      const catalog = new UiCatalogStore(
        {
          catalog: async () => ({
            ok: true,
            value: {
              hostEpoch: "00000000-0000-4000-8000-000000000001",
              revision,
              entries,
              nextCursor: null,
            },
          }),
          resource,
          onEvent: () => () => {},
        },
        () => {},
      );
      if (phase !== "pending") await catalog.start();
      const oldLab = Object.fromEntries(
        ["initialize", "getState", "list", "start", "onState", "watch", "listCalibrations"].map(
          (name) => [name, vi.fn()],
        ),
      );
      const previous = Object.getOwnPropertyDescriptor(window, "kobrixa");
      Object.defineProperty(window, "kobrixa", {
        configurable: true,
        value: { sensorLab: oldLab, device: oldLab },
      });
      const select = vi.fn(),
        onOpenTools = vi.fn();
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        act(() =>
          root.render(
            createElement(MonitorWorkspace, {
              plugins: { catalog, select },
              onOpenTools,
              locale: "en",
            }),
          ),
        );
        expect(host.querySelector(`[data-plugin-destination="${feature}"]`)?.textContent).toContain(
          phase === "pending"
            ? "Loading plugin tools"
            : phase === "available"
              ? "available in Plugin tools"
              : "is unavailable",
        );
        expect(select).not.toHaveBeenCalled();
        expect(resource).not.toHaveBeenCalled();
        const button = host.querySelector<HTMLButtonElement>(
          `[data-plugin-destination="${feature}"] button`,
        )!;
        act(() => button.click());
        expect(onOpenTools).toHaveBeenCalledTimes(1);
        expect(select).toHaveBeenCalledTimes(phase === "available" ? 1 : 0);
        if (phase === "available") {
          expect(select).toHaveBeenCalledWith(entries[0]);
          entries = [];
          revision++;
          await act(async () => {
            await catalog.refresh();
          });
          expect(
            host.querySelector(`[data-plugin-destination="${feature}"]`)?.textContent,
          ).toContain("is unavailable");
          act(() => button.click());
          expect(select).toHaveBeenCalledTimes(1);
        }
        for (const call of Object.values(oldLab)) expect(call).not.toHaveBeenCalled();
        expect(resource).not.toHaveBeenCalled();
        expect(host.querySelector('[data-testid="ev3-monitor"]')).toBeNull();
        expect(host.querySelector("input, select, .monitor-subtabs")).toBeNull();
      } finally {
        act(() => root.unmount());
        host.remove();
        catalog.dispose();
        if (previous) Object.defineProperty(window, "kobrixa", previous);
        else Reflect.deleteProperty(window, "kobrixa");
      }
    });
