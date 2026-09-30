import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { MockTransport } from "@kobrixa/device";
import { FileBatchManager } from "./file-batch.js";
import type { FileBatchRequest } from "../../shared/api.js";
const ROOT = "/home/root/lms2012/prjs";
const u32 = (n: number): number[] => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...b];
};
const text = (p: Uint8Array, start: number): string =>
  new TextDecoder().decode(p.slice(start, p.indexOf(0, start)));
describe("batch transfers over EV3 protocol", () => {
  it("uses segmented lists, uploads, downloads and EOF through MockTransport without leaking handles", async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), "kobrixa-wire-batch-"));
    const files = new Map<string, Uint8Array | null>([[ROOT, null]]);
    const handles = new Map<
      number,
      { data: Uint8Array; offset: number; path: string; size: number }
    >();
    const commands: number[] = [];
    let next = 0;
    const transport = new MockTransport((p) => {
      const command = p[1]!;
      commands.push(command);
      const reply = (status: number, data: number[] = []) =>
        Uint8Array.from([3, command, status, ...data]);
      if (command === 0x98) {
        handles.delete(p[2]!);
        return reply(0);
      }
      if (command === 0x9b) {
        files.set(text(p, 2), null);
        return reply(0);
      }
      if (command === 0x92) {
        const target = text(p, 6),
          size = new DataView(p.buffer, p.byteOffset + 2).getUint32(0, true);
        files.set(target, new Uint8Array());
        handles.set(++next, { path: target, size, offset: 0, data: new Uint8Array() });
        return reply(0, [next]);
      }
      if (command === 0x93) {
        const h = handles.get(p[2]!)!;
        h.data = Uint8Array.from([...h.data, ...p.slice(3)]);
        files.set(h.path, h.data);
        const done = h.data.length === h.size;
        if (done) handles.delete(p[2]!);
        return reply(done ? 8 : 0, [p[2]!]);
      }
      if (command === 0x99 || command === 0x94) {
        const target = text(p, 4).replace(/\/$/, "");
        if (!files.has(target)) return reply(6);
        const data =
          command === 0x94
            ? (files.get(target)! as Uint8Array)
            : new TextEncoder().encode(
                [...files]
                  .filter(([key]) => key !== target && path.posix.dirname(key) === target)
                  .map(([key, value]) =>
                    value === null
                      ? `${path.posix.basename(key)}/\n`
                      : `${createHash("md5").update(value).digest("hex")} ${value.length.toString(16).padStart(8, "0")} ${path.posix.basename(key)}\n`,
                  )
                  .join(""),
              );
        const id = ++next,
          count = Math.min(17, data.length);
        if (count < data.length)
          handles.set(id, { path: target, data, offset: count, size: data.length });
        return reply(count === data.length ? 8 : 0, [
          ...u32(data.length),
          id,
          ...data.slice(0, count),
        ]);
      }
      if (command === 0x9a || command === 0x95) {
        const id = p[2]!,
          h = handles.get(id)!,
          chunk = h.data.slice(h.offset, h.offset + 17);
        h.offset += chunk.length;
        const done = h.offset === h.size;
        if (done) handles.delete(id);
        return reply(done ? 8 : 0, [id, ...chunk]);
      }
      throw new Error(`Unexpected command ${command}`);
    });
    const signal = new AbortController().signal,
      session = await transport.connect(transport.descriptor, signal);
    try {
      await mkdir(path.join(local, "robot", "empty"), { recursive: true });
      await writeFile(path.join(local, "robot", "empty.rbf"), "");
      await writeFile(path.join(local, "robot", "long.rbf"), "segmented content\n".repeat(300));
      const download = path.join(local, "download");
      await mkdir(download);
      let selected = path.join(local, "robot");
      const manager = new FileBatchManager(
        async (_id, work) => work(session, signal),
        { showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }) },
        () => {},
        () => {},
      );
      const request: FileBatchRequest = {
        sessionId: "s",
        requestId: "r",
        action: "upload",
        path: ROOT,
        paths: [],
        source: "folders",
        locale: "en",
      };
      const upload = await manager.prepare(request, 1);
      expect((await manager.execute(upload, "skip", 1)).phase).toBe("complete");
      selected = download;
      const plan = await manager.prepare(
        { ...request, action: "download", paths: [`${ROOT}/robot`] },
        1,
      );
      expect((await manager.execute(plan, "skip", 1)).phase).toBe("complete");
      expect(await readFile(path.join(download, "robot", "long.rbf"), "utf8")).toBe(
        "segmented content\n".repeat(300),
      );
      expect(await readFile(path.join(download, "robot", "empty.rbf"))).toHaveLength(0);
      expect(commands).toEqual(expect.arrayContaining([0x99, 0x9a, 0x92, 0x93, 0x94, 0x95, 0x9b]));
      expect(handles.size).toBe(0);
    } finally {
      await session.disconnect();
      await rm(local, { recursive: true, force: true });
    }
  });
});
