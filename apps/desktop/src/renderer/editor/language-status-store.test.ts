import { expect, it, vi } from "vitest";
import type { LanguageStatus, LanguageStatusEvent } from "../../shared/language-services.js";
import { createLanguageStatusStore } from "./language-status-store.js";
const missing = (epoch: number): LanguageStatus => ({
  epoch,
  conflicts: [],
  availability: { kind: "unavailable", reason: "missing", language: "case" },
});
it("recovers without typing and ignores an older unavailable status", async () => {
  let emit!: (event: LanguageStatusEvent) => void;
  let resolve!: (status: LanguageStatus) => void;
  const off = vi.fn();
  const api = {
    status: vi.fn(
      () =>
        new Promise<LanguageStatus>((done) => {
          resolve = done;
        }),
    ),
    onStatus: (next: typeof emit) => {
      emit = next;
      return off;
    },
  };
  const store = createLanguageStatusStore(api);
  store.configure("w");
  emit({ workspaceId: "w", status: missing(2) });
  const available: LanguageStatus = {
    epoch: 3,
    conflicts: [],
    availability: {
      kind: "available",
      binding: {
        epoch: 3,
        pluginId: "test.case",
        sourceKey: "builtin:test.case",
        language: "case",
        extensions: ["csx"],
        capabilities: ["analysis"],
        frontend: {
          language: "case",
          entryExtensions: ["csx"],
          sourceExtensions: ["csx"],
          ir: { min: 1, max: 1 },
        },
      },
    },
  };
  emit({ workspaceId: "w", status: available });
  resolve(missing(1));
  await Promise.resolve();
  emit({ workspaceId: "w", status: missing(2) });
  expect(store.getSnapshot()).toEqual(available);
  emit({ workspaceId: "other", status: missing(99) });
  expect(store.getSnapshot()).toEqual(available);
  store.dispose();
  expect(off).toHaveBeenCalledOnce();
});

it("supports effect cleanup and reattachment without leaking a subscription", async () => {
  const listeners = new Set<(event: LanguageStatusEvent) => void>();
  const api = {
    status: vi.fn(async () => missing(1)),
    onStatus: (listener: (event: LanguageStatusEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  // React can discard a useMemo initializer without ever running its effects.
  createLanguageStatusStore(api);
  expect(listeners.size).toBe(0);
  const store = createLanguageStatusStore(api);
  store.configure("w");
  store.dispose();
  store.configure("w");
  await Promise.resolve();
  expect(listeners.size).toBe(1);
  expect(store.getSnapshot()).toEqual(missing(1));
  for (const emit of listeners) emit({ workspaceId: "w", status: missing(2) });
  expect(store.getSnapshot()).toEqual(missing(2));
  store.dispose();
  expect(listeners.size).toBe(0);
});
