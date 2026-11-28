import { expect, it, vi } from "vitest";
import type { DeviceSession } from "@kobrixa/device";
import { executeLegacy } from "./legacy.js";
it("F14 dispatches only the closed union and preserves transfer counts", async () => {
  const trace: string[] = [];
  const session = {
    list: vi.fn<DeviceSession["list"]>(async (path) =>
      path === "/home/root/lms2012/prjs"
        ? [{ name: "b", path: "/home/root/lms2012/prjs/b", kind: "directory" }]
        : [],
    ),
    download: vi.fn<DeviceSession["download"]>(async (_path, sink) => {
      await sink(Uint8Array.of(1, 2));
    }),
    uploadStream: vi.fn<DeviceSession["uploadStream"]>(async (_path, _size, chunks) => {
      for await (const bytes of chunks) trace.push(`bytes:${bytes.length}`);
    }),
    createDirectory: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
  } as unknown as DeviceSession;
  const bind = (step: string) => {
    trace.push(step);
    return session;
  };
  const signal = new AbortController().signal;
  expect(
    (await executeLegacy(bind, { kind: "list", remotePath: "/home/root/lms2012/prjs" }, signal))
      .kind,
  ).toBe("entries");
  const sink = vi.fn(async () => {});
  expect(
    await executeLegacy(
      bind,
      { kind: "download", remotePath: "/home/root/lms2012/prjs/a", sink, progress() {} },
      signal,
    ),
  ).toEqual({ kind: "transfer", transferred: 2 });
  await executeLegacy(
    bind,
    {
      kind: "upload",
      remotePath: "/home/root/lms2012/prjs/a",
      size: 3,
      chunks: (async function* () {
        yield Uint8Array.of(1, 2, 3);
      })(),
      progress() {},
    },
    signal,
  );
  await executeLegacy(bind, { kind: "mkdir", remotePath: "/home/root/lms2012/prjs/b" }, signal);
  await executeLegacy(
    bind,
    {
      kind: "rename",
      remotePath: "/home/root/lms2012/prjs/a",
      destination: "/home/root/lms2012/prjs/c",
    },
    signal,
  );
  await executeLegacy(bind, { kind: "delete", remotePath: "/home/root/lms2012/prjs/c" }, signal);
  expect(
    await executeLegacy(
      bind,
      { kind: "run", remotePath: "/home/root/lms2012/prjs/main.rbf" },
      signal,
    ),
  ).toEqual({ kind: "launch", sent: true });
  expect(trace).toEqual([
    "read",
    "read",
    "file-begin",
    "bytes:3",
    "file-mkdir",
    "read",
    "file-copy",
    "file-remove",
    "program-run",
  ]);
});
