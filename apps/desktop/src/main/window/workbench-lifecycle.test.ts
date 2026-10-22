import { expect, it, vi } from "vitest";
import { WorkbenchLifecycle } from "./workbench-lifecycle.js";

it("retires a window once, waits for all safety receipts, and readmits only fresh work after reopen", async () => {
  const trace: string[] = [];
  let finish!: () => void;
  const safety = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retirement = new WorkbenchLifecycle({
    sessions: () => ["original"],
    suspend: async (id) => {
      trace.push(`stop:${id}`);
      await safety;
    },
    verify: async () => {},
    retire: async () => {
      trace.push("retire");
    },
    resume: async (id) => {
      trace.push(`wake:${id}`);
    },
    readmit: async () => {
      trace.push("readmit");
    },
  });
  const closing = retirement.close();
  expect(retirement.close()).toBe(closing);
  const reopening = retirement.reopen();
  await Promise.resolve();
  expect(trace).toEqual(["retire", "stop:original"]);
  finish();
  await closing;
  await reopening;
  expect(trace).toEqual(["retire", "stop:original", "wake:original", "readmit"]);
  await retirement.close();
  expect(trace.filter((v) => v === "retire")).toHaveLength(2);
});
it("an unconfirmed stop or failed save keeps the window close and replacement admission blocked", async () => {
  const readmit = vi.fn(async () => {}),
    resume = vi.fn(async () => {});
  const retirement = new WorkbenchLifecycle({
    sessions: () => ["original"],
    suspend: async () => {
      throw new Error("stop unconfirmed");
    },
    verify: async () => {
      throw new Error("stop unconfirmed");
    },
    retire: async () => {},
    resume,
    readmit,
  });
  await expect(retirement.close()).rejects.toThrow("stop unconfirmed");
  await expect(retirement.reopen()).rejects.toThrow("stop unconfirmed");
  expect(resume).not.toHaveBeenCalled();
  expect(readmit).not.toHaveBeenCalled();
});

it.each(["wake", "cleanup"])(
  "opens the core recovery window after a blocked %s, without releasing admission or replacing receipts",
  async (failure) => {
    const error = new Error(failure === "wake" ? "disconnected before activation" : "save failed");
    const suspend = vi.fn(async () => {});
    const verify = vi.fn(async () => {});
    const retire = vi.fn(async () => {
      if (failure === "cleanup") throw error;
    });
    const resume = vi.fn(async () => {
      if (failure === "wake") throw error;
    });
    const readmit = vi.fn(async () => {});
    const life = new WorkbenchLifecycle({
      sessions: () => ["original"],
      suspend,
      verify,
      retire,
      resume,
      readmit,
    });
    await life.close().catch(() => {});
    const create = vi.fn(() => {
      expect(life.closing).toBe(true);
    });
    const report = vi.fn();
    await life.openWindow(create, report);
    expect(create).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(life.closing).toBe(true);
    expect(readmit).not.toHaveBeenCalled();
    expect(suspend).toHaveBeenCalledExactlyOnceWith("original");
    if (failure === "cleanup") {
      expect(resume).not.toHaveBeenCalled();
      expect(verify).toHaveBeenCalledExactlyOnceWith("original");
    } else {
      expect(resume).toHaveBeenCalledExactlyOnceWith("original");
      expect(retire).toHaveBeenCalledOnce();
    }
  },
);

it("explicit retry verifies the original stop receipt after recovery without another stop or deadline", async () => {
  let resolved = false;
  const suspend = vi.fn(async () => {
    throw new Error("unconfirmed");
  });
  const verify = vi.fn(async () => {
    if (!resolved) throw new Error("unconfirmed");
  });
  const resume = vi.fn(async () => {});
  const readmit = vi.fn(async () => {});
  const life = new WorkbenchLifecycle({
    sessions: () => ["original"],
    suspend,
    verify,
    retire: async () => {},
    resume,
    readmit,
  });
  await expect(life.close()).rejects.toThrow("unconfirmed");
  await expect(life.close()).rejects.toThrow("unconfirmed");
  expect(readmit).not.toHaveBeenCalled();
  resolved = true;
  await life.close();
  expect(resume).not.toHaveBeenCalled();
  await life.reopen();
  expect(suspend).toHaveBeenCalledOnce();
  expect(verify).toHaveBeenCalledTimes(2);
  expect(resume).toHaveBeenCalledExactlyOnceWith("original");
  expect(readmit).toHaveBeenCalledOnce();
});

it("the safety deadline rejects without readmission or a late implicit close", async () => {
  vi.useFakeTimers();
  try {
    let finish!: () => void;
    const retire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const readmit = vi.fn(async () => {});
    const lifecycle = new WorkbenchLifecycle({
      sessions: () => [],
      suspend: async () => {},
      verify: async () => {},
      retire,
      resume: async () => {},
      readmit,
      now: () => Date.now(),
    });
    const original = lifecycle.close();
    const blocked = expect(original).rejects.toThrow("safety deadline");
    await vi.advanceTimersByTimeAsync(25_000);
    await blocked;
    expect(lifecycle.close()).toBe(original);
    expect(retire).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(readmit).not.toHaveBeenCalled();
    expect(lifecycle.closing).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
