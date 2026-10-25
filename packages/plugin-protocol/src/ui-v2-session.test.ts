import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcPeer } from "./peer.js";
import { createMemoryChannelPair } from "./memory-channel.js";
import { requestMethods } from "./methods.js";
import { uiRequestSchemas } from "./ui-methods.js";
import { uiResourceVersionsV2Schema, validUiWireV2 } from "./ui-v2-session.js";
const id = "00000000-0000-4000-8000-000000000001";
const binding = {
  contributionId: "test.lab.panel",
  panelInstance: id,
  kind: "panel" as const,
  uiResourceGeneration: 1,
  generation: 1,
  hostEpoch: id,
  processEpoch: id,
};
const page = {
  ok: true as const,
  value: {
    revision: 1,
    presentation: 1,
    byteLength: 20,
    sha256: "a".repeat(64),
    header: { kind: "code" as const },
    chunk: { kind: "code" as const, entries: ["α"] },
    nextOffset: 1,
    done: true,
  },
};
const peers: RpcPeer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) peer.close();
});
function raw(ready = true) {
  const [local, remote] = createMemoryChannelPair();
  const peer = new RpcPeer(local);
  peers.push(peer);
  peer.setUiCandidate(true);
  peer.setUiSession(2, ready);
  return { peer, remote };
}
const read = { binding, dataset: "code", revision: 1, offset: 0, limit: 1 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("candidate UI session on actual RpcPeer", () => {
  it.each([[], [1], [2], [1, 2]].map((v) => [v]))(
    "accepts sorted unique version offers %j",
    (versions) => {
      expect(uiResourceVersionsV2Schema.safeParse(versions).success).toBe(true);
    },
  );
  it.each([[2, 1], [1, 1], [2, 2], [3]].map((v) => [v]))(
    "rejects malformed offers %j",
    (versions) => {
      expect(uiResourceVersionsV2Schema.safeParse(versions).success).toBe(false);
    },
  );
  it("registers six data methods, keeps v1 strict and rejects unoffered replies", () => {
    expect(Object.keys(requestMethods).filter((k) => k.startsWith("ui/data"))).toHaveLength(6);
    expect(
      uiRequestSchemas["ui/negotiate"].result.safeParse({
        ok: true,
        value: { commandEnvelopeVersions: [1], uiResourceVersions: [2] },
      }).success,
    ).toBe(false);
    expect(
      validUiWireV2(
        "ui/negotiate",
        "result",
        { ok: true, value: { commandEnvelopeVersions: [1], uiResourceVersions: [1, 2] } },
        { commandEnvelopeVersions: [1], uiResourceVersions: [2] },
      ),
    ).toBe(false);
  });
  it("gates both directions until ready and retains the v1 parser", async () => {
    const { peer, remote } = raw(false);
    const called = vi.fn(() => ({ ok: true as const, value: { datasets: [] } }));
    peer.handle("ui/dataSnapshot", called);
    await expect(peer.request("ui/dataSnapshot", { binding })).rejects.toThrow("not ready");
    remote.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ui/dataSnapshot", params: { binding } }),
    );
    await tick();
    expect(called).not.toHaveBeenCalled();
    peer.setUiCandidate(false);
    remote.onMessage((text) =>
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(text).id,
          result: { ok: true, value: { commandEnvelopeVersions: [1], uiResourceVersions: [2] } },
        }),
      ),
    );
    await expect(
      peer.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] }),
    ).rejects.toThrow("Invalid result");
  });
  it.each([65536, 65537])("counts original request whitespace bytes at %i", async (bytes) => {
    const { peer, remote } = raw();
    const called = vi.fn(() => ({ ok: true as const, value: { datasets: [] } }));
    peer.handle("ui/dataSnapshot", called);
    const wire = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/dataSnapshot",
      params: { binding },
    });
    remote.send(wire + " ".repeat(bytes - Buffer.byteLength(wire)));
    await tick();
    expect(called).toHaveBeenCalledTimes(bytes === 65536 ? 1 : 0);
  });
  it.each([false, true])(
    "counts original correlated response including error envelope (%s)",
    async (error) => {
      const { peer, remote } = raw();
      remote.onMessage((text) => {
        const request = JSON.parse(text);
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          ...(error ? { error: { code: -32603, message: "bad" } } : { result: page }),
        });
        remote.send(body + " ".repeat(65537 - Buffer.byteLength(body)));
      });
      await expect(peer.request("ui/dataRead", read)).rejects.toThrow("64 KiB");
    },
  );
  it("counts escape expansion and UTF8, accepts the exact boundary", async () => {
    const { peer, remote } = raw();
    remote.onMessage((text) => {
      const request = JSON.parse(text);
      const wire = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: page }).replace(
        "α",
        "\\u03b1",
      );
      remote.send(wire + " ".repeat(65536 - Buffer.byteLength(wire)));
    });
    await expect(peer.request("ui/dataRead", read)).resolves.toEqual(page);
  });
  it.each([
    { revision: 2 },
    { nextOffset: 2 },
    { chunk: { kind: "code", entries: [] }, done: false },
  ])("correlates read semantics with the original request: %j", async (change) => {
    const { peer, remote } = raw();
    remote.onMessage((text) =>
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(text).id,
          result: { ...page, value: { ...page.value, ...change } },
        }),
      ),
    );
    const params = structuredClone(read);
    const pending = peer.request("ui/dataRead", params);
    params.revision = 2;
    params.offset = 1;
    await expect(pending).rejects.toThrow("Invalid result");
  });
  it("rejects duplicate metadata and incorrectly paired error reasons", async () => {
    const { peer, remote } = raw();
    remote.onMessage((text) =>
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(text).id,
          result: {
            ok: false,
            error: {
              code: "PLUGIN_E_UI_RESOURCE",
              message: "bad",
              detail: { kind: "ui-data", reason: "expired" },
            },
          },
        }),
      ),
    );
    await expect(peer.request("ui/dataSnapshot", { binding })).rejects.toThrow("Invalid result");
    const meta = {
      dataset: "code",
      revision: 1,
      presentation: 1,
      byteLength: 20,
      sha256: "a".repeat(64),
    };
    expect(
      validUiWireV2("ui/dataSnapshot", "result", { ok: true, value: { datasets: [meta, meta] } }),
    ).toBe(false);
  });
  it("rejects malformed negotiation replies and revokes readiness", async () => {
    const { peer, remote } = raw();
    remote.onMessage((text) =>
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(text).id,
          result: { ok: true, value: { commandEnvelopeVersions: [1], uiResourceVersions: [1, 2] } },
        }),
      ),
    );
    await expect(
      peer.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [2] }),
    ).rejects.toThrow("Invalid result");
    await expect(peer.request("ui/dataSnapshot", { binding })).rejects.toThrow("not ready");
  });
  it("does not let a late response revive a retired session", async () => {
    const { peer, remote } = raw();
    remote.onMessage((text) => {
      peer.setUiSession(null);
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(text).id,
          result: { ok: true, value: {} },
        }),
      );
    });
    await expect(peer.request("ui/ready", {})).rejects.toThrow("retired");
    expect(peer.uiResourceVersion).toBeNull();
  });
});

it("correlates subscription metadata with its bound panel", () => {
  const value = {
    ok: true,
    value: {
      subscriptionId: id,
      sequence: 0,
      snapshot: {
        instances: [],
        states: [],
        locale: "en",
        theme: "light",
        data: [{ binding: { ...binding, generation: 2 }, datasets: [] }],
      },
    },
  };
  expect(validUiWireV2("ui/subscribe", "result", value, { topics: ["data"], binding })).toBe(false);
});

const initialize = (apiVersion: string) => ({
  apiVersion,
  pluginId: "test.lab",
  locale: "en" as const,
  grantedPermissions: [],
});
it.each([
  ["1.8.0", "1.7.0"],
  ["1.8.0", "1.6.0"],
  ["1.7.0", "1.8.0"],
  ["1.8.0", "1.8.0"],
])(
  "intersects initialize offer %s with remote SDK %s before v2 negotiation",
  async (offered, sdk) => {
    const [local, remote] = createMemoryChannelPair();
    const peer = new RpcPeer(local);
    peers.push(peer);
    let selected = 2;
    remote.onMessage((text) => {
      const request = JSON.parse(text);
      const result =
        request.method === "initialize"
          ? { apiVersion: sdk, sdk: { name: "test", version: "1.0.0" } }
          : { ok: true, value: { commandEnvelopeVersions: [1], uiResourceVersions: [selected] } };
      remote.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await peer.request("initialize", initialize(offered));
    const negotiation = peer.request("ui/negotiate", {
      commandEnvelopeVersions: [1],
      uiResourceVersions: [1, 2],
    });
    if (offered === "1.8.0" && sdk === "1.8.0") {
      await expect(negotiation).resolves.toMatchObject({ ok: true });
      expect(peer.uiResourceVersion).toBe(2);
    } else {
      await expect(negotiation).rejects.toThrow("Invalid result");
      expect(peer.uiResourceVersion).toBeNull();
      selected = 1;
      await expect(
        peer.request("ui/negotiate", { commandEnvelopeVersions: [1], uiResourceVersions: [1] }),
      ).resolves.toMatchObject({ ok: true });
      expect(peer.uiResourceVersion).toBe(1);
    }
  },
);
it.each(["error", "malformed", "aborted", "timeout"])(
  "does not retain candidate after %s initialize",
  async (mode) => {
    const { peer, remote } = raw();
    let initializeId: number | undefined;
    remote.onMessage((text) => {
      const request = JSON.parse(text);
      if (request.method !== "initialize") return;
      initializeId = request.id;
      if (mode === "error")
        remote.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: "failed" },
          }),
        );
      if (mode === "malformed")
        remote.send(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { apiVersion: "1.8.0" } }),
        );
    });
    const control = new AbortController();
    const pending = peer.request("initialize", initialize("1.8.0"), {
      signal: control.signal,
      timeoutMs: mode === "timeout" ? 5 : 1000,
    });
    expect(peer.uiResourceVersion).toBeNull();
    const rejected = expect(pending).rejects.toBeDefined();
    await tick();
    if (mode === "aborted") control.abort();
    await rejected;
    if (mode === "aborted" || mode === "timeout") {
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: initializeId,
          result: { apiVersion: "1.8.0", sdk: { name: "test", version: "1.0.0" } },
        }),
      );
      await tick();
    }
    expect(() => peer.setUiSession(2, true)).toThrow("not initialized");
  },
);

it.each([false, true])(
  "clears candidate for locally failed initialize (pre-aborted: %s)",
  async (aborted) => {
    const peer = new RpcPeer({
      send() {
        throw new Error("send failed");
      },
      onMessage() {
        return () => {};
      },
    });
    peers.push(peer);
    peer.setUiCandidate(true);
    peer.setUiSession(2, true);
    const control = new AbortController();
    if (aborted) control.abort();
    await expect(
      peer.request("initialize", initialize("1.8.0"), { signal: control.signal }),
    ).rejects.toThrow(aborted ? "cancelled" : "send failed");
    expect(() => peer.setUiSession(2, true)).toThrow("not initialized");
  },
);
it("ignores superseded initialize capability and never trusts incoming offers automatically", async () => {
  const [local, remote] = createMemoryChannelPair();
  const peer = new RpcPeer(local);
  peers.push(peer);
  const ids: number[] = [];
  remote.onMessage((text) => {
    const message = JSON.parse(text);
    if (message.method === "initialize") ids.push(message.id);
  });
  const first = peer.request("initialize", initialize("1.8.0"));
  const rejected = expect(first).rejects.toThrow("retired");
  const second = peer.request("initialize", initialize("1.8.0"));
  await tick();
  remote.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ids[1],
      result: { apiVersion: "1.7.0", sdk: { name: "test", version: "1.0.0" } },
    }),
  );
  await second;
  remote.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ids[0],
      result: { apiVersion: "1.8.0", sdk: { name: "test", version: "1.0.0" } },
    }),
  );
  await rejected;
  expect(() => peer.setUiSession(2, true)).toThrow("not initialized");
  peer.handle("initialize", () => ({
    apiVersion: "1.8.0",
    sdk: { name: "test", version: "1.0.0" },
  }));
  remote.send(
    JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: initialize("1.8.0") }),
  );
  await tick();
  expect(() => peer.setUiSession(2, true)).toThrow("not initialized");
});
