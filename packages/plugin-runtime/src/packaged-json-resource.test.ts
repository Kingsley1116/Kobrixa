import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STATIC_LANGUAGE_LIMITS_V1 as L } from "@kobrixa/plugin-protocol";
import { readBuiltinJson, readPackagedJson, SourceReadBudget } from "./packaged-json-resource.js";

let root: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-static-reader-"));
  directory = path.join(root, "plugin");
  await mkdir(directory);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
const read = (name: string) =>
  readPackagedJson(directory, name, L.resourceFileBytes, new SourceReadBudget());

it("counts the original UTF-8 bytes including BOM for both providers", async () => {
  const raw = '\uFEFF{"label":"😀"}';
  await writeFile(path.join(directory, "ok.json"), raw);
  const disk = await read("ok.json");
  const bundled = readBuiltinJson({ "ok.json": raw }, "ok.json", L.resourceFileBytes);
  expect(disk).toEqual(bundled);
  expect(disk.bytes).toBe(Buffer.byteLength(raw));
  expect(disk.value).toEqual({ label: "😀" });
});

it("accepts exactly 512 KiB and rejects one byte more, including growth after stat", async () => {
  const raw = "{}" + " ".repeat(L.resourceFileBytes - 2);
  await writeFile(path.join(directory, "max.json"), raw);
  expect((await read("max.json")).bytes).toBe(L.resourceFileBytes);
  await appendFile(path.join(directory, "max.json"), " ");
  await expect(read("max.json")).rejects.toMatchObject({
    limit: "resourceFileBytes",
    allowed: L.resourceFileBytes,
    actual: L.resourceFileBytes + 1,
  });
  await writeFile(path.join(directory, "grow.json"), "{}");
  await expect(
    readPackagedJson(directory, "grow.json", L.resourceFileBytes, new SourceReadBudget(), {
      stat: async (file) => {
        const result = await stat(file);
        await appendFile(file, " ".repeat(L.resourceFileBytes));
        return result;
      },
    }),
  ).rejects.toMatchObject({ limit: "resourceFileBytes" });
});

it("rejects traversal, absolute paths, URLs, escaping links, directories and malformed bytes", async () => {
  await writeFile(path.join(root, "outside.json"), "{}");
  await symlink(path.join(root, "outside.json"), path.join(directory, "escape.json"));
  await mkdir(path.join(directory, "dir.json"));
  await writeFile(path.join(directory, "bad.json"), "{");
  await writeFile(path.join(directory, "utf8.json"), Buffer.from([0xc3, 0x28]));
  for (const name of [
    "../outside.json",
    path.join(root, "outside.json"),
    "https://x/a.json",
    "a\\b.json",
    "escape.json",
    "dir.json",
    "missing.json",
    "bad.json",
    "utf8.json",
  ])
    await expect(read(name)).rejects.toThrow();
  expect(() => readBuiltinJson(Object.create({ "x.json": "{}" }), "x.json", 10)).toThrow();
});

it("charges metadata and every resource once, pauses between jobs and permanently rejects late work", async () => {
  vi.useFakeTimers();
  const budget = new SourceReadBudget(5000, () => Date.now());
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Construction/global orchestration waits consume none of this source's allowance.
  await vi.advanceTimersByTimeAsync(6000);
  const metadata = budget.run(() => budget.run(() => delay(2000)));
  await vi.advanceTimersByTimeAsync(2000);
  await metadata;
  await vi.advanceTimersByTimeAsync(6000);
  const tokenizer = budget.run(() => delay(2000));
  await vi.advanceTimersByTimeAsync(2000);
  await tokenizer;
  await vi.advanceTimersByTimeAsync(6000);
  let finish!: (value: number) => void;
  const configuration = budget.run(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const rejected = expect(configuration).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(999);
  expect(() => budget.check()).not.toThrow();
  await vi.advanceTimersByTimeAsync(1);
  await rejected; // Only 1,000 ms remained; neither resource got a fresh 5,000 ms.
  finish(123);
  const nextResource = vi.fn(async () => 456);
  await expect(budget.run(nextResource)).rejects.toThrow("deadline");
  expect(nextResource).not.toHaveBeenCalled();
});

it("charges failed I/O against the same remaining source allowance", async () => {
  vi.useFakeTimers();
  const budget = new SourceReadBudget(5000, () => Date.now());
  const failed = budget.run(
    () =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("unreadable")), 4000);
      }),
  );
  const rejected = expect(failed).rejects.toThrow("unreadable");
  await vi.advanceTimersByTimeAsync(4000);
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  const next = budget.run(() => new Promise<void>(() => {}));
  const expired = expect(next).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(1000);
  await expired;
});
