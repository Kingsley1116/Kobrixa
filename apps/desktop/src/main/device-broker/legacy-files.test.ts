import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { LegacyOperation, LegacyOperationPort } from "./broker-port.js";
import { LegacyFiles, type LegacyFileSession } from "./legacy-files.js";
function fixture() {
  const principal: Principal = {
    kind: "core",
    adapter: "remote-files",
    hostEpoch: randomUUID(),
    workbenchInstance: randomUUID(),
    authorityContext: { ref: randomUUID(), epoch: randomUUID() },
  };
  const op: LegacyOperation = {
    operationId: randomUUID(),
    execute: vi.fn<LegacyOperation["execute"]>(async (request) => ({
      value:
        request.kind === "list"
          ? { kind: "entries", entries: [] }
          : { kind: "mutation", verified: true },
      dispatch: "sent",
      stopConfirmation: "not-required",
      error: null,
    })),
    renewConfirmation: vi.fn(),
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const operations: LegacyOperationPort = { begin: vi.fn(async () => op) };
  return {
    op,
    operations,
    files: new LegacyFiles(
      operations,
      () => principal,
      () => performance.now(),
    ),
  };
}
afterEach(() => vi.useRealTimers());
it("F14/A-RF3 all file calls share one retained operation and stop after denied verification", async () => {
  const f = fixture();
  let calls = 0;
  vi.mocked(f.op.execute).mockImplementation(async () =>
    ++calls === 1
      ? {
          value: { kind: "mutation", verified: true },
          dispatch: "sent",
          stopConfirmation: "not-required",
          error: null,
        }
      : {
          value: null,
          dispatch: "sent",
          stopConfirmation: "not-required",
          error: { reason: "authority-changed", message: "Partial copy retained." },
        },
  );
  await expect(
    f.files.run("s", async (session, signal) => {
      await session.rename("/a", "/b", signal);
      await session.delete("/a", signal);
      await session.createDirectory("/next", signal);
    }),
  ).rejects.toThrow("Partial copy retained");
  expect(f.operations.begin).toHaveBeenCalledOnce();
  expect(f.op.execute).toHaveBeenCalledTimes(2);
  expect(f.op.cancel).toHaveBeenCalledOnce();
  expect(f.op.finish).toHaveBeenCalledOnce();
});
it.each([119999, 120000])(
  "F15 native confirmation at %i ms cannot revive an expired plan",
  async (elapsed) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const f = fixture();
    let answer!: (value: boolean) => void;
    const pending = f.files.run("s", async (session, signal) => {
      await session.confirm(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      await session.delete("/a", signal);
    });
    const result = pending.then(
      () => "ok",
      () => "expired",
    );
    await vi.advanceTimersByTimeAsync(elapsed);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await result).toBe(elapsed === 119999 ? "ok" : "expired");
    expect(f.op.execute).toHaveBeenCalledTimes(elapsed === 119999 ? 1 : 0);
  },
);
it("F15 explicit renew cannot exceed original 600000 ms; hidden time never renews", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture();
  let session!: LegacyFileSession;
  const pending = f.files.run("s", async (view) => {
    session = view;
    await view.confirm(() => new Promise<void>(() => {}));
  });
  const result = pending.catch(() => "expired");
  await vi.advanceTimersByTimeAsync(0);
  for (let n = 0; n < 5; n++) {
    await vi.advanceTimersByTimeAsync(100000);
    session.renewConfirmation();
  }
  await vi.advanceTimersByTimeAsync(99999);
  expect(session.remaining().totalRemainingMs).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe("expired");
  expect(() => session.renewConfirmation()).toThrow();
  expect(f.op.execute).not.toHaveBeenCalled();
});
it("AM-12 failed authority renewal cannot extend the confirmation idle deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture();
  let session!: LegacyFileSession;
  const pending = f.files.run("s", async (view) => {
    session = view;
    await view.confirm(() => new Promise<void>(() => {}));
  });
  const result = pending.catch(() => "expired");
  await vi.advanceTimersByTimeAsync(100000);
  vi.mocked(f.op.renewConfirmation).mockImplementation(() => {
    throw new Error("authority-changed");
  });
  expect(() => session.renewConfirmation()).toThrow("authority-changed");
  expect(session.remaining().idleRemainingMs).toBe(20000);
  await vi.advanceTimersByTimeAsync(20000);
  expect(await result).toBe("expired");
  expect(f.op.execute).not.toHaveBeenCalled();
});
it("F14 cancellation retains original cleanup and refuses a late chunk", async () => {
  const f = fixture();
  await expect(
    f.files.run("s", async (session, signal) => {
      await session.cancel();
      await session.upload("/a", Uint8Array.of(1), signal);
    }),
  ).rejects.toThrow();
  expect(f.op.execute).not.toHaveBeenCalled();
  expect(f.op.cancel).toHaveBeenCalledOnce();
});
it("T5fix confirmed execution outlives the 600 s plan deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture();
  let finish!: () => void;
  let aborted = false;
  vi.mocked(f.op.execute).mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      value: { kind: "mutation", verified: true },
      dispatch: "sent",
      stopConfirmation: "not-required",
      error: null,
    };
  });
  const result = f.files
    .run("s", async (session, signal) => {
      await session.confirm(async () => true);
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await session.delete("/a", signal);
    })
    .then(
      () => "ok",
      () => "expired",
    );
  await vi.advanceTimersByTimeAsync(600001);
  expect(aborted).toBe(false);
  finish();
  expect(await result).toBe("ok");
  expect(f.op.cancel).not.toHaveBeenCalled();
});
