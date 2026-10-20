import { expect, it, vi } from "vitest";
import { ExchangeLane, createContexts } from "./provider.js";
import { ID } from "./fake-provider.js";
it("F21 timeout quarantines occupancy until the underlying exchange settles", async () => {
  vi.useFakeTimers();
  let now = 0;
  const lane = new ExchangeLane(() => now);
  lane.reserve(ID);
  let release!: () => void;
  const invoked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const contexts = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: () => now,
    lane,
    check: () => {},
    progress: () => {},
    onStop: () => {},
  });
  const work = contexts.work.exchange("motion-pulse", async () => invoked);
  const rejected = expect(work).rejects.toThrow();
  await Promise.resolve();
  await Promise.resolve();
  now = 2000;
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(lane.quarantined).toBe(true);
  expect(lane.occupied).toBe(true);
  expect(() => lane.reserve("00000000-0000-4000-8000-000000000002")).toThrow();
  release();
  await Promise.resolve();
  await Promise.resolve();
  vi.useRealTimers();
});
it("A-RF1 stop after upload wins over late arm and brake never downgrades", async () => {
  const lane = new ExchangeLane(() => 0);
  lane.reserve(ID);
  let live = true;
  const sent: string[] = [];
  const c = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: () => 0,
    lane,
    check: () => {
      if (!live) throw new Error("revoked");
    },
    progress: () => {},
    onStop: () => {},
  });
  await c.work.exchange("helper-upload", async () => {
    sent.push("upload");
  });
  live = false;
  c.stop("cancelled", true);
  c.stop("cancelled", false);
  expect(c.cleanup.brakeRequired()).toBe(true);
  await expect(
    c.work.exchange("helper-arm", async () => {
      sent.push("arm");
    }),
  ).rejects.toThrow();
  await c.cleanup.exchange("stop", async () => {
    sent.push("stop");
  });
  expect(sent).toEqual(["upload", "stop"]);
  expect(c.cleanup.signal.aborted).toBe(false);
});

import { exchangeBudget } from "./provider.js";
it.each([
  ["motion-pulse", 2000],
  ["helper-run", 2000],
  ["helper-arm", 2000],
  ["stop", 2000],
  ["readback", 2000],
  ["file-chunk", 10000],
  ["helper-upload", 10000],
  ["file-copy", 10000],
  ["file-begin", 10000],
  ["file-mkdir", 5000],
  ["file-remove", 5000],
  ["connect", 5000],
] as const)(
  "F21 %s exchange is capped at %i without extending operation deadline",
  (step, expected) => {
    expect(exchangeBudget(step)).toBe(expected);
  },
);

it("file-close retains cleanup rights after ordinary cancellation and authority loss", async () => {
  const lane = new ExchangeLane(() => 0);
  lane.reserve(ID);
  let allowed = true;
  const calls: string[] = [];
  const ctx = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "file-write",
    deadline: 600000,
    now: () => 0,
    lane,
    check: () => {
      if (!allowed) throw new Error("revoked");
    },
    progress: () => {},
    onStop: () => {},
  });
  allowed = false;
  ctx.stop("cancelled", true);
  await ctx.work.exchange("file-close", async () => {
    calls.push("close");
  });
  await expect(
    ctx.work.exchange("file-remove", async () => {
      calls.push("delete");
    }),
  ).rejects.toThrow();
  expect(calls).toEqual(["close"]);
  expect(ctx.cleanup.signal.aborted).toBe(false);
});
it("concurrent exchanges never overlap a lane after the shared await", async () => {
  const lane = new ExchangeLane(() => 0);
  lane.reserve(ID);
  let release!: () => void;
  const calls: string[] = [];
  const first = lane.exchange(
    ID,
    10000,
    5000,
    () => {},
    async () => {
      calls.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  const second = lane.exchange(
    ID,
    10000,
    5000,
    () => {},
    async () => {
      calls.push("second");
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["first"]);
  release();
  await Promise.all([first, second]);
  expect(calls).toEqual(["first", "second"]);
});
