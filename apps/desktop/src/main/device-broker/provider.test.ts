import { expect, it, vi } from "vitest";
import { ExchangeLane, createContexts } from "./provider.js";
import { ID } from "./fake-provider.js";
it("F09/F21 timeout quarantines occupancy until the underlying exchange settles", async () => {
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
it("a rejected in-flight exchange does not cancel the queued safety stop", async () => {
  const lane = new ExchangeLane(() => 0);
  lane.reserve(ID);
  let rejectExchange!: (error: Error) => void;
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const c = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: () => 0,
    lane,
    check: () => {},
    progress: () => {},
    onStop: () => {},
  });
  const pending = c.work.exchange("preflight", () => {
    entered();
    return new Promise<void>((_resolve, reject) => {
      rejectExchange = reject;
    });
  });
  const failedWork = expect(pending).rejects.toThrow("cancelled original exchange");
  await reached;
  c.stop("cancelled", true);
  const stop = vi.fn(async () => "confirmed");
  const cleanup = c.cleanup.exchange("stop", stop);
  // Observe a rejection without an unhandled promise while arranging the race.
  const outcome = cleanup.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  rejectExchange(new Error("cancelled original exchange"));
  await failedWork;
  expect(await outcome).toEqual({ value: "confirmed" });
  expect(stop).toHaveBeenCalledOnce();
  expect(c.cleanup.signal.aborted).toBe(false);
  expect(lane.occupied).toBe(false);
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

it.each([Infinity, Number.MAX_SAFE_INTEGER, NaN])(
  "T5fix2 drain clamps unsafe deadline %s",
  async (deadline) => {
    const lane = new ExchangeLane(() => 0);
    const warnings: Error[] = [];
    const listener = (warning: Error) => warnings.push(warning);
    process.on("warning", listener);
    try {
      const first = lane.exchange(
        "sampler",
        5000,
        5000,
        () => {},
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      const drained = lane.drain(deadline);
      await expect(drained).resolves.toBeUndefined();
      await first;
      expect(lane.quarantined).toBe(false);
      expect(warnings.filter((warning) => warning.name === "TimeoutOverflowWarning")).toEqual([]);
    } finally {
      process.off("warning", listener);
    }
  },
);

it("contract2 recovery lease requires released foreground and settled transport, and retains quarantine", async () => {
  const lane = new ExchangeLane(() => 0);
  lane.reserve("original");
  lane.quarantined = true;
  expect(() => lane.reserveRecovery("recovery")).toThrow();
  let release!: () => void;
  const calls: string[] = [];
  const original = lane.exchange(
    "original",
    10000,
    5000,
    () => {},
    async () => {
      calls.push("original");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  lane.release("original");
  expect(() => lane.reserveRecovery("recovery")).toThrow();
  release();
  await original;
  lane.reserveRecovery("recovery");
  expect(lane.quarantined).toBe(true);
  expect(() => lane.reserveRecovery("concurrent")).toThrow();
  expect(() => lane.reserve("ordinary")).toThrow();
  await expect(
    lane.exchange(
      "original",
      10000,
      5000,
      () => {},
      async () => {
        calls.push("late-original");
      },
    ),
  ).rejects.toThrow();
  await lane.exchange(
    "recovery",
    10000,
    5000,
    () => {},
    async () => {
      calls.push("recovery");
    },
  );
  lane.releaseRecovery("wrong-lease");
  expect(() => lane.reserveRecovery("concurrent")).toThrow();
  lane.releaseRecovery("recovery");
  expect(calls).toEqual(["original", "recovery"]);
  expect(lane.quarantined).toBe(true);
  expect(() => lane.reserve("ordinary")).toThrow();
});
it("contract2 releasing a timed-out recovery never waives its underlying transport", async () => {
  vi.useFakeTimers();
  try {
    const lane = new ExchangeLane(() => Date.now());
    lane.quarantined = true;
    lane.reserveRecovery("recovery");
    let release!: () => void;
    const pending = lane.exchange(
      "recovery",
      Date.now() + 100,
      100,
      () => {},
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    lane.releaseRecovery("recovery");
    expect(lane.occupied).toBe(true);
    expect(() => lane.reserveRecovery("second")).toThrow();
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(lane.occupied).toBe(false);
    lane.reserveRecovery("second");
    lane.releaseRecovery("second");
    expect(lane.quarantined).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
