import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { acquireOutputLock } from "./output-lock.js";
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-lock-")));
});
afterEach(() => rm(root, { recursive: true, force: true }));
it("reclaims only stale locks and never releases another owner", async () => {
  const file = path.join(root, ".kobrixa-build.lock");
  await writeFile(file, JSON.stringify({ pid: 123456, startedAt: Date.now() }));
  const release = await acquireOutputLock(root, new AbortController().signal, {
    pidAlive: () => false,
  });
  const other = JSON.stringify({ pid: process.pid, startedAt: Date.now() + 100 });
  await writeFile(file, other);
  await release();
  expect(await readFile(file, "utf8")).toBe(other);
  await writeFile(file, "broken");
  const old = new Date(Date.now() - 61_000);
  await utimes(file, old, old);
  const releaseOld = await acquireOutputLock(root, new AbortController().signal);
  await releaseOld();
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("reclaims a same-process stale lock without waiting", async () => {
  const file = path.join(root, ".kobrixa-build.lock");
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() - 1_000 });
  await writeFile(file, content);
  let now = Date.now();
  const waits: number[] = [];
  const release = await acquireOutputLock(root, new AbortController().signal, {
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    pidAlive: () => true,
  });
  expect(waits).toEqual([]);
  const current = await readFile(file, "utf8");
  expect(JSON.parse(current)).toMatchObject({ pid: process.pid });
  expect(current).not.toBe(content);
  await release();
  await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
});
it("polls active or freshly malformed locks every 100 ms for at most 5 seconds", async () => {
  for (const content of [
    JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() }),
    "fresh malformed",
  ]) {
    await writeFile(path.join(root, ".kobrixa-build.lock"), content);
    let now = Date.now();
    const waits: number[] = [];
    await expect(
      acquireOutputLock(root, new AbortController().signal, {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        pidAlive: () => true,
      }),
    ).rejects.toMatchObject({ code: "BUILD1004" });
    expect(waits).toHaveLength(50);
    expect(waits.every((ms) => ms === 100)).toBe(true);
    expect(await readFile(path.join(root, ".kobrixa-build.lock"), "utf8")).toBe(content);
  }
});
it("cancels while waiting without removing the active lock", async () => {
  const file = path.join(root, ".kobrixa-build.lock");
  const content = JSON.stringify({ pid: process.pid + 1, startedAt: Date.now() });
  await writeFile(file, content);
  const controller = new AbortController();
  await expect(
    acquireOutputLock(root, controller.signal, {
      pidAlive: () => true,
      sleep: async () => {
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(file, "utf8")).toBe(content);
});
