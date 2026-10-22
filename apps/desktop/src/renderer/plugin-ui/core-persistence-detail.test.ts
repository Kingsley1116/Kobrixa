// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";
import { handle } from "./contract.test.js";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import type { PersistenceRecoveryBridge } from "../../shared/plugin-persistence.js";
import { CorePersistenceDetail, CorePersistenceRecovery } from "./core-persistence-detail.js";
it.each(["checkpoint-only", "none"] as const)(
  "U11/U15 never offers payload retry for %s even if a stale option is supplied",
  async (payload) => {
    const snapshot: PersistenceRecoverySnapshot = {
      revision: 1,
      items: [
        {
          id: handle(1),
          sourceKey: "builtin:acme.ui",
          pluginId: "acme.ui",
          recordId: null,
          committedRevision: null,
          state: "checkpoint-only",
          payload,
          actions: [
            { id: handle(2), kind: "retry" },
            { id: handle(3), kind: "export" },
            { id: handle(4), kind: "discard" },
          ],
        },
      ],
    };
    const onAction = vi.fn(async () => {});
    const div = document.createElement("div");
    const root = createRoot(div);
    await act(async () =>
      root.render(createElement(CorePersistenceDetail, { snapshot, labels, onAction })),
    );
    expect([...div.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Export",
      "Discard",
    ]);
    await act(async () => div.querySelector<HTMLButtonElement>("button")!.click());
    expect(onAction).toHaveBeenCalledWith(handle(1), handle(3));
    await act(async () => root.unmount());
  },
);
it("U11 offers retry only for complete retained staging and sends IDs without payload/token", async () => {
  const snapshot: PersistenceRecoverySnapshot = {
    revision: 1,
    items: [
      {
        id: handle(1),
        sourceKey: "builtin:acme.ui",
        pluginId: "acme.ui",
        recordId: null,
        committedRevision: null,
        state: "retryable",
        payload: "complete-staging",
        actions: [{ id: handle(2), kind: "retry" }],
      },
    ],
  };
  const onAction = vi.fn(async () => {});
  const div = document.createElement("div");
  const root = createRoot(div);
  await act(async () =>
    root.render(createElement(CorePersistenceDetail, { snapshot, labels, onAction })),
  );
  await act(async () => div.querySelector<HTMLButtonElement>("button")!.click());
  expect(onAction).toHaveBeenCalledWith(handle(1), handle(2));
  await act(async () => root.unmount());
});

it("AM-18 opens only via onOpen, dispatches option IDs, refreshes and unsubscribes", async () => {
  let open!: Parameters<PersistenceRecoveryBridge["onOpen"]>[0];
  let changed!: () => void;
  const offOpen = vi.fn();
  const offChanged = vi.fn();
  const value: PersistenceRecoverySnapshot = {
    revision: 1,
    items: [
      {
        id: handle(1),
        sourceKey: "builtin:acme.ui",
        pluginId: "acme.ui",
        recordId: null,
        committedRevision: null,
        state: "retryable",
        payload: "complete-staging",
        actions: [{ id: handle(2), kind: "retry" }],
      },
    ],
  };
  const port = {
    snapshot: vi.fn<PersistenceRecoveryBridge["snapshot"]>(async () => ({ ok: true, value })),
    act: vi.fn<PersistenceRecoveryBridge["act"]>(async () => ({ ok: true, value })),
    onOpen: (listener: typeof open) => {
      open = listener;
      return offOpen;
    },
    onChanged: (listener: () => void) => {
      changed = listener;
      return offChanged;
    },
  };
  const div = document.createElement("div");
  const root = createRoot(div);
  await act(async () => root.render(createElement(CorePersistenceRecovery, { port, labels })));
  expect(port.snapshot).not.toHaveBeenCalled();
  await act(async () => open({ itemId: handle(9) }));
  expect(port.snapshot).toHaveBeenLastCalledWith({ itemId: handle(9) });
  await act(async () => div.querySelector<HTMLButtonElement>("button")!.click());
  expect(port.act).toHaveBeenCalledWith({ itemId: handle(9), optionId: handle(2) });
  expect(port.snapshot).toHaveBeenCalledTimes(2);
  await act(async () => changed());
  expect(port.snapshot).toHaveBeenCalledTimes(3);
  await act(async () => root.unmount());
  expect(offOpen).toHaveBeenCalledTimes(1);
  expect(offChanged).toHaveBeenCalledTimes(1);
});
