// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { fixture, handle } from "./contract.test.js";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { CoreRecoveryStore, CoreRecoveryView } from "./core-recovery.js";
it("U11/U15 core unconfirmed stop remains operable with no optional catalog or process", async () => {
  const f = fixture();
  const item = {
    id: handle(8),
    sourceKey: "builtin:acme.ui",
    kind: "device" as const,
    state: "unconfirmed" as const,
    title: { en: "Stop not confirmed" },
    detail: { en: "Check the device" },
    actions: [{ id: handle(9), kind: "stop" as const }],
  };
  f.recovery.snapshot.mockResolvedValue({
    ok: true,
    value: { hostEpoch: handle(1), revision: 1, items: [item], nextCursor: null },
  });
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  await act(async () =>
    root.render(createElement(CoreRecoveryView, { port: f.recovery, locale: "en", labels })),
  );
  expect(div.textContent).toContain("Stop not confirmed");
  expect(f.bridge.catalog).not.toHaveBeenCalled();
  expect(f.bridge.open).not.toHaveBeenCalled();
  await act(async () =>
    [...div.querySelectorAll("button")].find((button) => button.textContent === "Stop")!.click(),
  );
  expect(f.recovery.act).toHaveBeenCalledWith({ itemId: item.id, actionId: handle(9) });
  expect(Object.keys(f.recovery.act.mock.calls[0]![0]).sort()).toEqual(["actionId", "itemId"]);
  await act(async () => root.unmount());
  div.remove();
});
it("U04 reads recovery pages atomically and keeps the last fault visible on a paging failure", async () => {
  const f = fixture();
  const store = new CoreRecoveryStore(f.recovery);
  await store.start();
  f.recovery.snapshot.mockResolvedValueOnce({
    ok: true,
    value: { hostEpoch: handle(1), revision: 2, items: [], nextCursor: handle(4) },
  });
  await store.refresh();
  f.recovery.snapshot.mockResolvedValueOnce({
    ok: true,
    value: { hostEpoch: handle(1), revision: 3, items: [], nextCursor: null },
  });
  await store.next();
  expect(store.getSnapshot().problem).toBe(true);
  expect(store.getSnapshot().revision).toBe(2);
  store.stop();
});

import { diagnosticsFor } from "./host-ports.js";
it("AM-22 stopping a stalled recovery fetch clears every local timer", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.recovery.snapshot.mockReturnValue(new Promise(() => {}));
    const store = new CoreRecoveryStore(f.recovery);
    const diagnostics = diagnosticsFor(store);
    const ready = store.start();
    expect(diagnostics.snapshot().timers).toBe(1);
    store.stop();
    await ready;
    expect(Object.values(diagnostics.snapshot()).every((value) => value === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("retains diagnostics for the actual mounted recovery store after unmount", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.recovery.snapshot.mockReturnValue(new Promise(() => {}));
  const div = document.createElement("div");
  const root = createRoot(div);
  let observed: CoreRecoveryStore | undefined;
  try {
    await act(async () =>
      root.render(
        createElement(CoreRecoveryView, {
          port: f.recovery,
          locale: "en",
          labels,
          observeStore: (store) => {
            observed = store;
          },
        }),
      ),
    );
    expect(observed).toBeInstanceOf(CoreRecoveryStore);
    const diagnostic = diagnosticsFor(observed!);
    expect(f.recovery.snapshot).toHaveBeenCalledOnce();
    expect(diagnostic.snapshot().timers).toBe(1);
    await act(async () => root.unmount());
    expect(Object.values(diagnostic.snapshot()).every((value) => value === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
