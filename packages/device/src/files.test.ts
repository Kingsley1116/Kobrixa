import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MockTransport,
  managedPath,
  remoteChild,
  parseDirectoryListing,
  REMOTE_PROJECT_ROOT as ROOT,
} from "./index.js";
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const u32 = (value: number): number[] => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value);
  return [...b];
};
const text = (p: Uint8Array, offset: number): string =>
  new TextDecoder().decode(p.slice(offset, p.indexOf(0, offset)));

/** A framed, in-memory stock-firmware responder, including MOVE's copy semantics. */
function filesystem() {
  const files = new Map<string, Uint8Array | null>([[ROOT, null]]);
  const handles = new Map<
    number,
    { path: string; data: Uint8Array; offset: number; size: number }
  >();
  let corruptCopy = false,
    failRemove = false,
    handle = 0;
  const commands: Uint8Array[] = [];
  const responder = (p: Uint8Array): Uint8Array => {
    commands.push(p);
    const reply = (status: number, data: number[] = []): Uint8Array =>
      Uint8Array.from([3, p[1]!, status, ...data]);
    if (p[0] === 0) {
      const from = text(p, 6);
      if (p[4] === 31) {
        const to = text(p, p.indexOf(0, 6) + 2);
        for (const [key, value] of [...files])
          if (key === from || key.startsWith(`${from}/`))
            files.set(
              to + key.slice(from.length),
              value === null ? null : corruptCopy ? bytes("corrupt") : value.slice(),
            );
      } else if (p[4] === 30 && !failRemove) {
        for (const key of files.keys())
          if (key === from || key.startsWith(`${from}/`)) files.delete(key);
      }
      return Uint8Array.of(2);
    }
    if (p[1] === 0x9b) {
      files.set(text(p, 2), null);
      return reply(0);
    }
    if (p[1] === 0x98) {
      handles.delete(p[2]!);
      return reply(0);
    }
    if (p[1] === 0x92) {
      const path = text(p, 6),
        size = new DataView(p.buffer, p.byteOffset + 2).getUint32(0, true);
      files.set(path, new Uint8Array());
      handles.set(++handle, { path, size, data: new Uint8Array(), offset: 0 });
      return reply(0, [handle]);
    }
    if (p[1] === 0x93) {
      const h = handles.get(p[2]!)!;
      h.data = Uint8Array.from([...h.data, ...p.slice(3)]);
      files.set(h.path, h.data);
      const done = h.data.length === h.size;
      if (done) handles.delete(p[2]!);
      return reply(done ? 8 : 0, [p[2]!]);
    }
    if (p[1] === 0x99 || p[1] === 0x94) {
      const path = text(p, 4).replace(/\/$/, "");
      if (!files.has(path)) return reply(6);
      const data =
        p[1] === 0x94
          ? (files.get(path)! as Uint8Array)
          : bytes(
              [...files]
                .filter(([key]) => key !== path && key.slice(0, key.lastIndexOf("/")) === path)
                .map(([key, value]) =>
                  value === null
                    ? `${key.split("/").at(-1)}/\n`
                    : `${createHash("md5").update(value).digest("hex")} ${value.length.toString(16).padStart(8, "0")} ${key.split("/").at(-1)}\n`,
                )
                .join(""),
            );
      const id = ++handle,
        count = Math.min(17, data.length); // Split entries across many packets.
      if (count < data.length) handles.set(id, { path, data, size: data.length, offset: count });
      return reply(count === data.length ? 8 : 0, [
        ...u32(data.length),
        id,
        ...data.slice(0, count),
      ]);
    }
    if (p[1] === 0x9a || p[1] === 0x95) {
      const id = p[2]!,
        h = handles.get(id)!;
      const chunk = h.data.slice(h.offset, h.offset + 17);
      h.offset += chunk.length;
      const done = h.offset === h.size;
      if (done) handles.delete(id);
      return reply(done ? 8 : 0, [id, ...chunk]);
    }
    throw new Error(`Unexpected command ${p}`);
  };
  const transport = new MockTransport(responder);
  return {
    files,
    commands,
    handles,
    session: () => transport.connect(transport.descriptor, signal()),
    corrupt: () => {
      corruptCopy = true;
    },
    denyRemove: () => {
      failRemove = true;
    },
  };
}

describe("EV3 managed files", () => {
  it("rejects paths outside projects, traversal and mutations of storage roots", () => {
    for (const value of [
      "/",
      "/home/root/lms2012/prjs-other",
      `${ROOT}/../sys`,
      `${ROOT}/a/../../b`,
    ])
      expect(() => managedPath(value)).toThrow();
    for (const value of [ROOT, `${ROOT}/SD_Card`, `${ROOT}/USB_Stick`]) {
      expect(managedPath(value)).toBe(value);
      expect(() => managedPath(value, true)).toThrow();
    }
    for (const name of ["..", "a/b", "a\\b", " a", "a\0", "x$()", "x".repeat(120)])
      expect(() => remoteChild(ROOT, name)).toThrow();
  });
  it("reads multi-packet directory lists and sorts folders before files", async () => {
    const h = filesystem();
    h.files.set(`${ROOT}/z.rbf`, bytes("data"));
    h.files.set(`${ROOT}/folder`, null);
    h.files.set(`${ROOT}/empty`, new Uint8Array());
    const session = await h.session();
    const entries = await session.list(ROOT, signal());
    expect(entries.map((e) => e.name)).toEqual(["folder", "empty", "z.rbf"]);
    expect(entries[1]?.size).toBe(0);
    expect(entries[2]?.checksum).toHaveLength(32);
    expect(h.commands.filter((p) => p[1] === 0x9a).length).toBeGreaterThan(1);
    expect(h.handles.size).toBe(0);
  });
  it("streams complete downloads and handles zero-byte files", async () => {
    const h = filesystem();
    const data = bytes("0123456789".repeat(200));
    h.files.set(`${ROOT}/large`, data);
    h.files.set(`${ROOT}/empty`, new Uint8Array());
    const session = await h.session(),
      chunks: number[] = [];
    const progress = vi.fn();
    await session.download(
      `${ROOT}/large`,
      async (chunk) => {
        chunks.push(...chunk);
      },
      signal(),
      progress,
    );
    expect(chunks).toEqual([...data]);
    expect(progress).toHaveBeenLastCalledWith(2000, 2000);
    await session.download(
      `${ROOT}/empty`,
      async (chunk) => {
        expect(chunk.length).toBe(0);
      },
      signal(),
    );
    expect(h.handles.size).toBe(0);
  });
  it("uploads streamed chunks, overwrites and closes zero-byte handles", async () => {
    const h = filesystem(),
      session = await h.session();
    const target = `${ROOT}/data`;
    await session.upload(target, bytes("old"), signal());
    await session.uploadStream(
      target,
      1802,
      (async function* () {
        yield new Uint8Array(901);
        yield new Uint8Array(901);
      })(),
      signal(),
    );
    expect(h.files.get(target)?.length).toBe(1802);
    await session.upload(target, new Uint8Array(), signal());
    expect(h.files.get(target)?.length).toBe(0);
    expect(h.handles.size).toBe(0);
  });
  it("creates, verifies a recursive rename, and recursively deletes folders", async () => {
    const h = filesystem(),
      session = await h.session();
    await session.createDirectory(`${ROOT}/before`, signal());
    h.files.set(`${ROOT}/before/nested`, null);
    h.files.set(`${ROOT}/before/nested/data`, bytes("verified"));
    await session.rename(`${ROOT}/before`, `${ROOT}/after`, signal());
    expect(h.files.has(`${ROOT}/before`)).toBe(false);
    expect(h.files.get(`${ROOT}/after/nested/data`)).toEqual(bytes("verified"));
    await session.delete(`${ROOT}/after`, signal());
    expect([...h.files.keys()]).toEqual([ROOT]);
  });
  it("refuses collisions and preserves the source when copy verification fails", async () => {
    const h = filesystem(),
      session = await h.session();
    h.files.set(`${ROOT}/source`, bytes("original"));
    h.files.set(`${ROOT}/taken`, bytes("existing"));
    await expect(session.rename(`${ROOT}/source`, `${ROOT}/taken`, signal())).rejects.toThrow(
      "already exists",
    );
    expect(h.commands.some((p) => p[0] === 0)).toBe(false);
    h.corrupt();
    await expect(session.rename(`${ROOT}/source`, `${ROOT}/copy`, signal())).rejects.toThrow(
      "Source retained",
    );
    expect(h.files.get(`${ROOT}/source`)).toEqual(bytes("original"));
    expect(h.commands.some((p) => p[0] === 0 && p[4] === 30)).toBe(false);
  });
  it("reports the verified destination when source removal fails", async () => {
    const h = filesystem(),
      session = await h.session();
    h.files.set(`${ROOT}/source`, bytes("original"));
    h.denyRemove();
    await expect(session.rename(`${ROOT}/source`, `${ROOT}/copy`, signal())).rejects.toThrow(
      "Verified copy exists",
    );
    expect(h.files.get(`${ROOT}/copy`)).toEqual(h.files.get(`${ROOT}/source`));
  });
  it("rejects malformed directory records", () => {
    for (const listing of ["bad\n", "../bad/\n", "a/\na/\n", "00 00 data\n"])
      expect(() => parseDirectoryListing(ROOT, listing)).toThrow();
  });
  it("closes transfer handles when a local sink fails", async () => {
    const h = filesystem(),
      session = await h.session();
    h.files.set(`${ROOT}/data`, bytes("large".repeat(100)));
    await expect(
      session.download(
        `${ROOT}/data`,
        async () => {
          throw new Error("disk full");
        },
        signal(),
      ),
    ).rejects.toThrow("disk full");
    expect(h.handles.size).toBe(0);
    expect(h.commands.at(-1)?.[1]).toBe(0x98);
  });
  it.each(["premature EOF", "wrong handle", "oversized"])(
    "rejects %s in a download",
    async (scenario) => {
      const commands: number[] = [];
      const transport = new MockTransport((p) => {
        commands.push(p[1]!);
        return p[1] === 0x94
          ? Uint8Array.from([
              3,
              0x94,
              scenario === "premature EOF" ? 8 : 0,
              ...u32(scenario === "oversized" ? 0 : 2),
              7,
              1,
            ])
          : p[1] === 0x95
            ? Uint8Array.of(3, 0x95, 8, 9, 2)
            : Uint8Array.of(3, 0x98, 0);
      });
      const session = await transport.connect(transport.descriptor, signal());
      await expect(session.download(`${ROOT}/bad`, async () => {}, signal())).rejects.toThrow();
      if (scenario === "oversized") expect(commands.at(-1)).toBe(0x98);
    },
  );
  it("times out a stalled continuation and closes its handle", async () => {
    vi.useFakeTimers();
    try {
      const commands: number[] = [];
      const transport = new MockTransport((p) => {
        commands.push(p[1]!);
        if (p[1] === 0x94) return Uint8Array.from([3, 0x94, 0, ...u32(2), 7, 1]);
        if (p[1] === 0x95) return new Promise<Uint8Array>(() => {});
        return Uint8Array.of(3, 0x98, 0);
      });
      const session = await transport.connect(transport.descriptor, signal());
      const checked = expect(
        session.download(`${ROOT}/data`, async () => {}, signal()),
      ).rejects.toMatchObject({ category: "timeout" });
      await vi.advanceTimersByTimeAsync(10001);
      await checked;
      expect(commands.at(-1)).toBe(0x98);
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects an in-flight read when the mock device disconnects", async () => {
    const transport = new MockTransport(() => new Promise<Uint8Array>(() => {}));
    const session = await transport.connect(transport.descriptor, signal());
    const checked = expect(session.list(ROOT, signal())).rejects.toMatchObject({
      category: "connection",
    });
    await Promise.resolve();
    await session.disconnect();
    await checked;
  });
  it("rejects concurrent operations and use after disconnect", async () => {
    let release!: (data: Uint8Array) => void;
    const transport = new MockTransport(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const session = await transport.connect(transport.descriptor, signal());
    const pending = session.list(ROOT, signal());
    await expect(session.stop()).rejects.toThrow("already running");
    release(Uint8Array.from([3, 0x99, 8, ...u32(0), 1]));
    await pending;
    await session.disconnect();
    await expect(session.list(ROOT, signal())).rejects.toThrow("disconnected");
  });
});
