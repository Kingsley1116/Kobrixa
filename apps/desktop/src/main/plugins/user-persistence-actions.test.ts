import { describe, expect, it } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import { UserPersistenceActions } from "./user-persistence-actions.js";

const owner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "acme.ui",
  generation: 1,
  hostEpoch: "host",
  processEpoch: "process",
};
const scope = { hostEpoch: "host", workbenchInstance: "window-1" };
function fixture() {
  let now = 0;
  let live = true;
  const ledger = new UserPersistenceActions(
    () => now,
    () => live,
  );
  const mint = () => ledger.mint(owner, scope, 3);
  return {
    ledger,
    mint,
    time: (value: number) => {
      now = value;
    },
    retire: () => {
      live = false;
    },
  };
}
describe("one user gesture, one feature persistence claim", () => {
  it("denies invocation/option IDs and consumes export/copy across purposes", () => {
    const h = fixture();
    const ref = h.mint();
    expect(h.ledger.claim({ owner, actionRef: "invocation-id" }, "storage.export").ok).toBe(false);
    expect(h.ledger.claim({ owner, actionRef: "core-option-id" }, "storage.export").ok).toBe(false);
    expect(h.ledger.claim({ owner, actionRef: ref }, "ui.clipboard")).toEqual({
      ok: true,
      value: { action: ref },
    });
    expect(h.ledger.claim({ owner, actionRef: ref }, "storage.export").ok).toBe(false);
  });
  it("expires exactly at 5,000 ms without extending on a denied request", () => {
    const h = fixture();
    const ref = h.mint();
    h.time(5_000);
    expect(h.ledger.claim({ owner, actionRef: ref }, "storage.export")).toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_E_PERMISSION_DENIED",
        detail: { kind: "permission", reason: "user-action-required" },
      },
    });
  });
  it.each(["sourceKey", "pluginId", "hostEpoch", "processEpoch"] as const)("binds %s", (field) => {
    const h = fixture();
    const ref = h.mint();
    expect(
      h.ledger.claim({ owner: { ...owner, [field]: "foreign" }, actionRef: ref }, "storage.export")
        .ok,
    ).toBe(false);
    expect(h.ledger.claim({ owner, actionRef: ref }, "storage.export").ok).toBe(true);
  });
  it("checks generation and current UI/window lifetime at claim time", () => {
    const h = fixture();
    const ref = h.mint();
    expect(
      h.ledger.claim({ owner: { ...owner, generation: 2 }, actionRef: ref }, "ui.clipboard").ok,
    ).toBe(false);
    h.retire();
    expect(h.ledger.claim({ owner, actionRef: ref }, "ui.clipboard").ok).toBe(false);
  });
  it("revokes all refs on workbench replacement", () => {
    const h = fixture();
    const ref = h.mint();
    h.ledger.revokeWindow(scope);
    expect(h.ledger.claim({ owner, actionRef: ref }, "storage.export").ok).toBe(false);
  });
  it("does not create an unbounded ledger when a renderer keeps clicking", () => {
    const h = fixture();
    for (let i = 0; i < 256; i++) h.mint();
    expect(() => h.mint()).toThrow();
    h.time(5_000);
    expect(() => h.mint()).not.toThrow();
  });
});
