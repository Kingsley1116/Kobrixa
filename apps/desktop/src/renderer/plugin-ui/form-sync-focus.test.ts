// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { PanelResourceV2 } from "@kobrixa/plugin-protocol";
import { UiStateStore } from "./state-store.js";
import { UiIntentController } from "./intent-controller.js";
import { PanelTree } from "./components.js";
import { fixture, snapshot, labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("late form backfill preserves the focused native text input and newer draft", async () => {
  const f = fixture();
  const resource: PanelResourceV2 = {
    kind: "panel",
    formSync: true,
    root: "root",
    presentationKey: "presentation",
    datasets: {},
    data: {
      presentation: {
        schema: {
          type: "number",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          integer: true,
          nullable: false,
        },
        initial: 0,
      },
    },
    fields: {
      draft: {
        schema: { type: "string", nullable: false, maxLength: 4000 },
        initial: "",
        required: false,
      },
    },
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["draft"] },
      { id: "draft", type: "textInput", field: "draft", label: { en: "Draft" } },
    ],
  };
  const state = new UiStateStore(f.bridge, resource, {
    ...snapshot(),
    data: { presentation: 0 },
    form: { draft: "" },
  });
  const intent = new UiIntentController(f.bridge, state);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () =>
      root.render(createElement(PanelTree, { state, intent, locale: "en", labels })),
    );
    const input = element.querySelector("input")!;
    await act(async () => state.edit("draft", "-"));
    input.focus();
    input.setSelectionRange(1, 1);
    f.bridge.snapshot.mockResolvedValueOnce({
      ok: true,
      value: {
        ...snapshot(),
        data: { presentation: 0 },
        formRevision: 1,
        form: { draft: "capture" },
      },
    });
    await act(async () => {
      await state.invalidateForm(1);
    });
    expect(element.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("-");
    expect(input.selectionStart).toBe(1);
  } finally {
    intent.dispose();
    state.retire();
    await act(async () => root.unmount());
    element.remove();
  }
});
