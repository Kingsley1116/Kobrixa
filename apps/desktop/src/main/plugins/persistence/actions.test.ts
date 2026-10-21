import { expect, it, vi } from "vitest";
import { PersistenceFault } from "./record-port.js";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  createPersistenceActions,
  type ActionDependencies,
  type ExportDestination,
} from "./actions.js";
const owner: ResourceOwner = {
  sourceKey: "builtin:test.actions",
  pluginId: "test.actions",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const p = { kind: "plugin" as const, owner, authorityContext: null };
const actionRef = "00000000-0000-4000-8000-000000000003";
function fixture() {
  let now = 0,
    alive = true,
    used = false;
  let choose!: (value: ExportDestination | null) => void;
  const copyText = vi.fn(async () => {}),
    begin = vi.fn(async () => {});
  const deps: ActionDependencies = {
    now: () => now,
    wall: () => 100000 + now,
    live: () => alive,
    permission: () => true,
    actions: {
      claim: (context) => {
        if (
          context.actionRef !== actionRef ||
          context.owner.generation !== 1 ||
          now >= 5000 ||
          used
        )
          return {
            ok: false,
            error: {
              code: "PLUGIN_E_PERMISSION_DENIED",
              message: "User action required.",
              detail: { kind: "permission", reason: "user-action-required" },
            },
          };
        used = true;
        return { ok: true, value: { action: actionRef } };
      },
    },
    adapter: {
      copyText,
      chooseDestination: () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    },
    destinations: {
      register: async () => {
        throw new Error("Native registration is exercised by the worker test.");
      },
      release: vi.fn(async () => {}),
    },
    output: {
      begin,
      append: async (_id, _offset, data) => data.length,
      commit: async () => ({
        disposition: "committed",
        commitId: actionRef,
        durability: "file-sync-only",
      }),
      reconcile: async () => ({ disposition: "unknown" }),
      abort: async () => "aborted",
    },
  };
  return {
    service: createPersistenceActions(deps),
    deps,
    copyText,
    begin,
    advance: (ms: number) => {
      now += ms;
    },
    die: () => {
      alive = false;
    },
    choose: (value: ExportDestination | null) => choose(value),
  };
}
it("B2-RF4: fabricated, expired, foreign and invocation IDs never touch clipboard", async () => {
  for (const ref of ["invocation-id", "foreign", ""]) {
    const f = fixture();
    expect(
      await f.service.request(
        p,
        "ui/copyText",
        { actionRef: ref, text: "hello" },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false });
    expect(f.copyText).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.advance(5000);
  expect(
    await f.service.request(
      p,
      "ui/copyText",
      { actionRef, text: "hello" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false });
  expect(f.copyText).not.toHaveBeenCalled();
});
it("B2-RF4: one action cannot copy then export; text errors never disclose values", async () => {
  const f = fixture();
  expect(
    await f.service.request(
      p,
      "ui/copyText",
      { actionRef, text: "hello" },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, value: { copied: true } });
  expect(
    await f.service.request(
      p,
      "storage/exportBegin",
      {
        actionRef,
        suggestedName: "data",
        mediaType: "text/plain",
        byteLength: 0,
        sha256: "a".repeat(64),
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false });
  expect(f.copyText).toHaveBeenCalledOnce();
  expect(f.begin).not.toHaveBeenCalled();
});
it("B2-12.1-8: late dialog after window loss or 120 seconds cannot start I/O", async () => {
  for (const end of ["window", "deadline"] as const) {
    const f = fixture();
    const r = await f.service.request(
      p,
      "storage/exportBegin",
      {
        actionRef,
        suggestedName: "data",
        mediaType: "text/plain",
        byteLength: 0,
        sha256: "a".repeat(64),
      },
      new AbortController().signal,
    );
    expect(r).toMatchObject({ ok: true, value: { state: "waiting" } });
    if (end === "window") f.die();
    else f.advance(120000);
    f.choose(Object.freeze({}) as ExportDestination);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.begin).not.toHaveBeenCalled();
  }
});
it("B2-12.1-8: copy checks both UTF-8 bytes and code points, NUL and surrogates", async () => {
  for (const text of ["a".repeat(16385), "😀".repeat(16385), "\0", "\ud800"]) {
    const f = fixture();
    await expect(
      f.service.request(p, "ui/copyText", { actionRef, text }, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.copyText).not.toHaveBeenCalled();
  }
  const f = fixture();
  expect(
    await f.service.request(
      p,
      "ui/copyText",
      { actionRef, text: "😀".repeat(16384) },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true });
  const g = fixture();
  g.deps.adapter.copyText = async () => {
    throw new Error("/private/secret text");
  };
  const failed = await g.service.request(
    p,
    "ui/copyText",
    { actionRef, text: "secret" },
    new AbortController().signal,
  );
  expect(failed).toMatchObject({ error: { detail: { reason: "clipboard-unavailable" } } });
  expect(JSON.stringify(failed)).not.toContain("secret");
});
it("B2-RF4: 8 MiB is admitted, larger payloads and path names cause no native operation", async () => {
  const maximum = fixture();
  expect(
    await maximum.service.request(
      p,
      "storage/exportBegin",
      {
        actionRef,
        suggestedName: "data.json",
        mediaType: "application/json",
        byteLength: 8388608,
        sha256: "a".repeat(64),
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: true });
  maximum.service.retire(owner);
  for (const suggestedName of ["../data", "C:data", "NUL", ".", "..", "\\server", " "]) {
    const f = fixture();
    await expect(
      f.service.request(
        p,
        "storage/exportBegin",
        {
          actionRef,
          suggestedName,
          mediaType: "text/plain",
          byteLength: 0,
          sha256: "a".repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.begin).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(
    f.service.request(
      p,
      "storage/exportBegin",
      {
        actionRef,
        suggestedName: "data",
        mediaType: "text/plain",
        byteLength: 8388609,
        sha256: "a".repeat(64),
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.begin).not.toHaveBeenCalled();
});
it("B2-12.1-8: independent exports have one source slot and four host slots", async () => {
  const f = fixture();
  f.deps.actions.claim = () => ({ ok: true, value: { action: actionRef } });
  const begin = {
    actionRef,
    suggestedName: "data",
    mediaType: "text/plain" as const,
    byteLength: 0,
    sha256: "a".repeat(64),
  };
  const principals = [0, 1, 2, 3].map((n) => ({
    ...p,
    owner: { ...owner, sourceKey: `builtin:test.export${n}` },
  }));
  for (const principal of principals)
    expect(
      await f.service.request(
        principal,
        "storage/exportBegin",
        begin,
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true });
  expect(
    await f.service.request(
      principals[0]!,
      "storage/exportBegin",
      begin,
      new AbortController().signal,
    ),
  ).toMatchObject({ error: { code: "PLUGIN_E_RESOURCE_LIMIT" } });
  expect(
    await f.service.request(p, "storage/exportBegin", begin, new AbortController().signal),
  ).toMatchObject({ ok: false });
  for (const principal of principals) f.service.retire(principal.owner);
});
it("B2-RF4: destination identity failure is sanitized and cannot replace the file", async () => {
  const f = fixture();
  const replacement = vi.fn();
  f.deps.output.commit = async () => {
    throw new PersistenceFault("PLUGIN_E_STORAGE_IO", "destination-changed");
  };
  f.deps.output.reconcile = replacement;
  const begun = await f.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    new AbortController().signal,
  );
  if (!begun.ok) throw new Error("begin failed");
  f.choose(Object.freeze({}) as ExportDestination);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const result = await f.service.request(
    p,
    "storage/exportCommit",
    { export: begun.value.export },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ error: { detail: { reason: "destination-changed" } } });
  expect(JSON.stringify(result)).not.toContain("path");
  expect(replacement).not.toHaveBeenCalled();
});
it("uses cumulative output offsets and releases a late destination after disposal", async () => {
  const f = fixture();
  f.deps.output.append = async (_id, offset, data) => offset + data.length;
  const begun = await f.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 2,
      sha256: "a".repeat(64),
    },
    new AbortController().signal,
  );
  if (!begun.ok) throw new Error("begin failed");
  f.choose(Object.freeze({}) as ExportDestination);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  for (const [offset, data] of [
    [0, "AQ=="],
    [1, "Ag=="],
  ] as const)
    expect(
      await f.service.request(
        p,
        "storage/exportChunk",
        { export: begun.value.export, offset, data },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: true, value: { receivedBytes: offset + 1 } });
  await f.service.dispose();
  const late = fixture();
  await late.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    new AbortController().signal,
  );
  await late.service.dispose();
  const destination = Object.freeze({}) as ExportDestination;
  late.choose(destination);
  await vi.waitFor(() => expect(late.deps.destinations.release).toHaveBeenCalledWith(destination));
  expect(late.begin).not.toHaveBeenCalled();
});

it("T5fix disposal joins a dispatched begin and its eventual abort", async () => {
  const f = fixture();
  let release!: () => void,
    begun = false,
    done = false;
  f.deps.output.begin = async () => {
    begun = true;
    await new Promise<void>((r) => {
      release = r;
    });
  };
  f.deps.output.abort = vi.fn(async () => (done ? "aborted" : "unknown"));
  await f.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    new AbortController().signal,
  );
  f.choose(Object.freeze({}) as ExportDestination);
  await vi.waitFor(() => expect(begun).toBe(true));
  let closed = false;
  const closing = f.service.dispose().then(() => {
    closed = true;
  });
  try {
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(false);
  } finally {
    done = true;
    release();
    await closing;
  }
  expect(f.deps.destinations.release).toHaveBeenCalledOnce();
});

it("T5fix unknown aborts retain original job identity past terminal eviction", async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.output.begin = () =>
    new Promise<void>((r) => {
      release = r;
    });
  f.deps.output.abort = async () => "unknown";
  f.deps.output.reconcile = async () => ({ disposition: "unknown" });
  const signal = new AbortController().signal;
  const result = await f.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    signal,
  );
  if (!result.ok) throw new Error("begin failed");
  f.choose(Object.freeze({}) as ExportDestination);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.service.retire(owner);
  release();
  await new Promise((r) => setImmediate(r));
  f.advance(240001);
  expect(
    await f.service.request(p, "storage/exportStatus", { export: result.value.export }, signal),
  ).toMatchObject({ ok: true, value: { state: "publishing" } });
  expect(f.deps.destinations.release).not.toHaveBeenCalled();
  await f.service.dispose();
});

it("T5fix pending aborts cannot evict the job before their outcome is known", async () => {
  const f = fixture();
  let finishAbort!: () => void;
  f.deps.output.abort = () =>
    new Promise((resolve) => {
      finishAbort = () => resolve("unknown");
    });
  const signal = new AbortController().signal;
  const result = await f.service.request(
    p,
    "storage/exportBegin",
    {
      actionRef,
      suggestedName: "data",
      mediaType: "text/plain",
      byteLength: 0,
      sha256: "a".repeat(64),
    },
    signal,
  );
  if (!result.ok) throw new Error("begin failed");
  f.choose(Object.freeze({}) as ExportDestination);
  await vi.waitFor(() => expect(f.begin).toHaveBeenCalledOnce());
  f.service.retire(owner);
  f.advance(240001);
  const status = await f.service.request(
    p,
    "storage/exportStatus",
    {
      export: result.value.export,
    },
    signal,
  );
  finishAbort();
  await new Promise((resolve) => setImmediate(resolve));
  f.deps.output.abort = async () => "unknown";
  await f.service.dispose();
  expect(status).toMatchObject({ ok: true });
  expect(f.deps.destinations.release).not.toHaveBeenCalled();
});
