import { describe, expect, it, vi } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceAuthorityReport } from "../../shared/collab.js";
import { AuthorityContexts } from "./authority-context.js";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const local = {
  state: "local",
  roomId: null,
  connected: true,
  synced: true,
  role: null,
  isHolder: true,
} as const;
const room = {
  state: "room",
  roomId: "room-1",
  connected: true,
  synced: true,
  role: "host",
  isHolder: true,
} as const;
function fixture() {
  let n = 10;
  const contexts = new AuthorityContexts(id(1), () => id(n++));
  const document = contexts.open(7);
  let sequence = 0;
  const report = (state: Omit<DeviceAuthorityReport, "document" | "sequence">) =>
    contexts.report(7, { ...state, document, sequence: ++sequence });
  const principal = () => contexts.core(7, "deployment");
  return { contexts, document, report, principal };
}

describe("trusted authority: F02/F03/F05/F14 and A-RF3", () => {
  it("does not infer local authority from an absent sender, document, or report", () => {
    const f = fixture();
    expect(() => f.contexts.core(99, "deployment")).toThrow("unbound");
    const p = f.principal();
    expect(() => f.contexts.assertContinuation(p, p.authorityContext!.ref)).toThrow("unbound");
    for (const value of [
      null,
      true,
      {},
      { ...local, document: f.document, sequence: 0, owner: {} },
    ])
      expect(() => f.contexts.report(7, value)).toThrow();
  });
  it.each([
    [{ ...room, state: "joining", synced: false }, "joining"],
    [{ ...room, state: "unsynced", synced: false }, "unsynced"],
    [{ ...room, role: "viewer", isHolder: true }, "viewer"],
    [{ ...room, isHolder: false }, "not-holder"],
    [{ ...room, connected: false }, "unsynced"],
  ] as const)("denies %j", (report, reason) => {
    const f = fixture();
    f.report(report);
    const p = f.principal();
    expect(() => f.contexts.assertContinuation(p, p.authorityContext!.ref)).toThrow(reason);
  });
  it.each([local, room, { ...room, role: "editor" as const }])("allows explicit %j", (state) => {
    const f = fixture();
    f.report(state);
    const p = f.principal();
    expect(() => f.contexts.assertContinuation(p, p.authorityContext!.ref)).not.toThrow();
  });
  it("rejects a different full owner even when pluginId and generation match", () => {
    const f = fixture();
    f.report(local);
    const owner: ResourceOwner = {
      sourceKey: "dev:one",
      pluginId: "test.consumer",
      generation: 2,
      hostEpoch: id(1),
      processEpoch: id(2),
    };
    const p = f.contexts.plugin(7, owner);
    expect(f.contexts.current(p, p.authorityContext!.ref)).not.toBeNull();
    for (const patch of [
      { sourceKey: "dev:two" },
      { processEpoch: id(3) },
      { hostEpoch: id(4) },
      { generation: 3 },
    ]) {
      const foreign: Principal = { ...p, owner: { ...owner, ...patch } };
      expect(f.contexts.current(foreign, p.authorityContext!.ref)).toBeNull();
    }
  });
  it("rotates epochs for reconnect, demotion, reclaim, release and explicit leave", () => {
    const f = fixture();
    const changed = vi.fn();
    f.contexts.subscribe(changed);
    let previous = f.principal();
    for (const report of [
      room,
      { ...room, state: "unsynced" as const, synced: false },
      room,
      { ...room, role: "viewer" as const, isHolder: false },
      { ...room, role: "editor" as const, isHolder: false },
      { ...room, role: "editor" as const, isHolder: true },
      { ...room, role: "editor" as const, isHolder: false },
      local,
    ]) {
      f.report(report);
      const next = f.principal();
      expect(next.authorityContext!.epoch).not.toBe(previous.authorityContext!.epoch);
      expect(() => f.contexts.assertContinuation(previous, previous.authorityContext!.ref)).toThrow(
        "authority-changed",
      );
      previous = next;
    }
    expect(changed).toHaveBeenCalledTimes(8);
  });
  it("does not refresh the original epoch during a continuation", async () => {
    const f = fixture();
    f.report(local);
    const original = f.principal();
    const writes: string[] = [];
    const consequential = async (name: string) => {
      f.contexts.assertContinuation(original, original.authorityContext!.ref);
      writes.push(name);
      await Promise.resolve();
      f.contexts.assertContinuation(original, original.authorityContext!.ref);
    };
    await consequential("chunk-1");
    f.report({ ...room, isHolder: false });
    f.report(local);
    await expect(consequential("chunk-2")).rejects.toThrow("authority-changed");
    expect(writes).toEqual(["chunk-1"]);
  });
  it.each([
    "drain",
    "journal",
    "preflight",
    "helper-upload",
    "helper-run",
    "ready-read",
    "arm",
    "pulse",
    "poll",
    "rename-verify",
    "file-close",
    "batch-entry",
    "final-journal",
  ])("rechecks after %s, preserving the independent stop lane", async (boundary) => {
    const f = fixture();
    f.report(local);
    const p = f.principal();
    const sent = vi.fn();
    const stop = vi.fn();
    const task = async () => {
      f.contexts.assertContinuation(p, p.authorityContext!.ref);
      await Promise.resolve(boundary);
      f.contexts.assertContinuation(p, p.authorityContext!.ref);
      sent();
    };
    const pending = task();
    f.contexts.invalidate(7);
    await expect(pending).rejects.toThrow();
    stop();
    expect(sent).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
  it("rejects late reports from an old document and does not revive old bindings", () => {
    const f = fixture();
    f.report(local);
    const p = f.principal();
    f.contexts.invalidate(7);
    const nextDocument = f.contexts.open(7);
    expect(nextDocument).not.toBe(f.document);
    expect(() => f.report(local)).toThrow("document");
    f.contexts.report(7, { ...local, document: nextDocument, sequence: 1 });
    expect(f.contexts.current(p, p.authorityContext!.ref)).toBeNull();
    const newPrincipal = f.principal();
    expect(newPrincipal.kind === "core" && newPrincipal.workbenchInstance).not.toBe(
      p.kind === "core" && p.workbenchInstance,
    );
  });
  it("ignores duplicate/older report sequence without restoring a previous state", () => {
    const f = fixture();
    f.report(local);
    f.report({ ...room, isHolder: false });
    const p = f.principal();
    f.contexts.report(7, { ...local, document: f.document, sequence: 1 });
    expect(f.principal()).toEqual(p);
    expect(() => f.contexts.assertContinuation(p, p.authorityContext!.ref)).toThrow("not-holder");
  });
});
