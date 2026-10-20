import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { EV3DeviceSession } from "@kobrixa/device";
import type { ProviderOperationContext, ProviderStep } from "../../device-broker/provider.js";
import { buildEv3Provider } from "./provider.js";
function ctx(sessionId: string | null = null): ProviderOperationContext {
  return {
    operationId: randomUUID(),
    operationClass: "file-write",
    sessionId,
    providerGeneration: 1,
    cancellation: new AbortController().signal,
    deadlineMonotonicMs: 600000,
    now: () => 0,
    assertContinuation: vi.fn(),
    shouldYield: () => false,
    stopState: () => ({ requested: false, brakeRequired: false }),
    exchange: async (_step, invoke) => invoke(new AbortController().signal, 10000),
    publishProgress() {},
    requestSafetyStop() {},
  };
}
it("F14/F21 checks begin, every chunk and original file-close; mutation loss preserves partial outcome", async () => {
  const descriptor = {
    id: "usb:private",
    name: "Brick",
    transport: "usb" as const,
    serialNumber: "A",
    metadata: { path: "private" },
  };
  let revoked = false;
  const commands: number[] = [],
    steps: ProviderStep[] = [];
  const raw = new EV3DeviceSession(descriptor, {
    async exchange(payload) {
      commands.push(payload[1]!);
      if (payload[1] === 0x92) return Uint8Array.of(3, 0x92, 0, 7);
      if (payload[1] === 0x93) {
        revoked = true;
        return Uint8Array.of(3, 0x93, 0, 7);
      }
      return Uint8Array.of(3, 0x98, 0);
    },
    transmit: async () => {},
    close: async () => {},
  });
  const transport = { discover: async () => [descriptor], connect: async () => raw };
  const provider = buildEv3Provider(
    {
      connectionPolicy: () =>
        ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }) as const,
      identify: () => randomUUID(),
    },
    { usb: transport, wifi: transport },
  );
  const discovered = await provider.discover(ctx());
  expect(discovered.value![0]!.descriptor).not.toHaveProperty("metadata");
  const connected = await provider.connect(discovered.value![0]!.key, ctx());
  const work = ctx(randomUUID());
  work.assertContinuation = (step) => {
    if (revoked && step !== "file-close") throw new Error("authority-changed");
  };
  work.exchange = async (step, invoke) => {
    steps.push(step);
    work.assertContinuation(step);
    return invoke(new AbortController().signal, 10000);
  };
  const result = await provider.legacy(
    connected.value!.key,
    {
      kind: "upload",
      remotePath: "/home/root/lms2012/prjs/a",
      size: 1801,
      chunks: (async function* () {
        yield new Uint8Array(1801);
      })(),
      progress() {},
    },
    work,
  );
  expect(result.error?.reason).toBe("authority-changed");
  expect(result.dispatch).not.toBe("not-sent");
  expect(commands).toEqual([0x92, 0x93, 0x98]);
  expect(steps).toContain("file-close");
});
it("F02 unknown opaque candidate does not use transport fallback", async () => {
  const connect = vi.fn();
  const provider = buildEv3Provider(
    {
      connectionPolicy: () =>
        ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }) as const,
      identify: () => randomUUID(),
    },
    { usb: { discover: async () => [], connect }, wifi: { discover: async () => [], connect } },
  );
  const result = await provider.connect({} as Parameters<typeof provider.connect>[0], ctx());
  expect(result.error).not.toBeNull();
  expect(connect).not.toHaveBeenCalled();
});
it("F14/A-RF3 revocation after rename verification preserves both copies and sends no delete", async () => {
  const descriptor = {
    id: "usb:p",
    name: "Brick",
    transport: "usb" as const,
    metadata: { path: "p" },
  };
  const root = "/home/root/lms2012/prjs";
  let revoked = false,
    lists = 0;
  const mutations: number[] = [];
  const raw = new EV3DeviceSession(descriptor, {
    async exchange(payload) {
      if (payload[0] === 0) {
        mutations.push(payload[4]!);
        return Uint8Array.of(2);
      }
      expect(payload[1]).toBe(0x99);
      lists++;
      const text =
        `${"a".repeat(32)} 00000001 a.rbf\n` +
        (lists > 1 ? `${"a".repeat(32)} 00000001 b.rbf\n` : "");
      const data = Buffer.from(text),
        length = Buffer.alloc(4);
      length.writeUInt32LE(data.length);
      if (lists > 1) revoked = true;
      return Uint8Array.from([3, 0x99, 8, ...length, 0xff, ...data]);
    },
    transmit: async () => {},
    close: async () => {},
  });
  const transport = { discover: async () => [descriptor], connect: async () => raw };
  const provider = buildEv3Provider(
    {
      connectionPolicy: () =>
        ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }) as const,
      identify: () => randomUUID(),
    },
    { usb: transport, wifi: transport },
  );
  const candidates = await provider.discover(ctx()),
    connection = await provider.connect(candidates.value![0]!.key, ctx());
  const work = ctx(randomUUID());
  work.assertContinuation = () => {
    if (revoked) throw new Error("authority-changed");
  };
  const result = await provider.legacy(
    connection.value!.key,
    { kind: "rename", remotePath: `${root}/a.rbf`, destination: `${root}/b.rbf` },
    work,
  );
  expect(lists).toBe(2);
  expect(mutations).toEqual([31]);
  expect(result).toMatchObject({
    dispatch: "sent",
    value: null,
    error: { reason: "authority-changed" },
  });
  expect(result.error!.message).toContain("partial");
});
it("F09 a lost chunk reply stays unknown even after successful original-handle close", async () => {
  const descriptor = {
    id: "usb:p",
    name: "Brick",
    transport: "usb" as const,
    metadata: { path: "p" },
  };
  const commands: number[] = [];
  const raw = new EV3DeviceSession(descriptor, {
    async exchange(payload) {
      commands.push(payload[1]!);
      if (payload[1] === 0x92) return Uint8Array.of(3, 0x92, 0, 7);
      if (payload[1] === 0x93) throw new Error("lost reply");
      return Uint8Array.of(3, 0x98, 0);
    },
    transmit: async () => {},
    close: async () => {},
  });
  const transport = { discover: async () => [descriptor], connect: async () => raw };
  const provider = buildEv3Provider(
    {
      connectionPolicy: () =>
        ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }) as const,
      identify: () => randomUUID(),
    },
    { usb: transport, wifi: transport },
  );
  const candidates = await provider.discover(ctx()),
    connection = await provider.connect(candidates.value![0]!.key, ctx());
  const result = await provider.legacy(
    connection.value!.key,
    {
      kind: "upload",
      remotePath: "/home/root/lms2012/prjs/a",
      size: 1,
      chunks: (async function* () {
        yield Uint8Array.of(1);
      })(),
      progress() {},
    },
    ctx(randomUUID()),
  );
  expect(result.dispatch).toBe("unknown");
  expect(commands).toEqual([0x92, 0x93, 0x98]);
});
it.each([false, true])(
  "F09 no-reply program launch has one dispatch; failed write=%s",
  async (fail) => {
    const descriptor = {
      id: "usb:p",
      name: "Brick",
      transport: "usb" as const,
      metadata: { path: "p" },
    };
    const transmit = vi.fn(async () => {
      if (fail) throw new Error("disconnected");
    });
    const raw = new EV3DeviceSession(descriptor, {
      exchange: async () => Uint8Array.of(2),
      transmit,
      close: async () => {},
    });
    const transport = { discover: async () => [descriptor], connect: async () => raw };
    const provider = buildEv3Provider(
      {
        connectionPolicy: () =>
          ({
            wifiConnectTimeoutMs: 5000,
            wifiHandshakeTimeoutMs: 3000,
            usbAutoReconnect: true,
            usbRetryInterval: "backoff",
            usbRetryLimit: "unlimited",
          }) as const,
        identify: () => randomUUID(),
      },
      { usb: transport, wifi: transport },
    );
    const candidates = await provider.discover(ctx()),
      connection = await provider.connect(candidates.value![0]!.key, ctx());
    const result = await provider.legacy(
      connection.value!.key,
      { kind: "run", remotePath: "/home/root/lms2012/prjs/a.rbf" },
      ctx(randomUUID()),
    );
    expect(transmit).toHaveBeenCalledOnce();
    expect(result.dispatch).toBe(fail ? "unknown" : "sent");
    expect(result.value).toEqual(fail ? null : { kind: "launch", sent: true });
  },
);

it.each(["before-chunk", "after-chunk", "close-fails"])(
  "AM-05 cleanup remains independent: %s",
  async (point) => {
    const descriptor = {
      id: "usb:cleanup",
      name: "Brick",
      transport: "usb" as const,
      serialNumber: "cleanup",
    };
    const commands: number[] = [];
    const cancellation = new AbortController();
    const cleanup = new AbortController();
    let revoked = false;
    const raw = new EV3DeviceSession(descriptor, {
      async exchange(payload, signal) {
        commands.push(payload[1]!);
        if (payload[1] === 0x92) {
          if (point === "before-chunk") {
            revoked = true;
            cancellation.abort();
          }
          return Uint8Array.of(3, 0x92, 0, 7);
        }
        if (payload[1] === 0x93) {
          revoked = true;
          cancellation.abort();
          return Uint8Array.of(3, 0x93, 0, 7);
        }
        expect(payload[1]).toBe(0x98);
        expect(payload[2]).toBe(7);
        expect(signal).toBe(cleanup.signal);
        expect(signal.aborted).toBe(false);
        if (point === "close-fails") throw new Error("readback-failed");
        return Uint8Array.of(3, 0x98, 0);
      },
      transmit: async () => {},
      close: async () => {},
    });
    const transport = { discover: async () => [descriptor], connect: async () => raw };
    const provider = buildEv3Provider(
      {
        identify: () => randomUUID(),
        connectionPolicy: () => ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }),
      },
      { usb: transport, wifi: transport },
    );
    const found = await provider.discover(ctx());
    const connection = await provider.connect(found.value![0]!.key, ctx());
    const work: ProviderOperationContext = {
      ...ctx(randomUUID()),
      cancellation: cancellation.signal,
    };
    work.assertContinuation = (step) => {
      if (step !== "file-close" && revoked) throw new Error("authority-changed");
    };
    work.exchange = async (step, invoke) => {
      work.assertContinuation(step);
      return invoke(step === "file-close" ? cleanup.signal : new AbortController().signal, 5000);
    };
    const result = await provider.legacy(
      connection.value!.key,
      {
        kind: "upload",
        remotePath: "/home/root/lms2012/prjs/a",
        size: 1801,
        chunks: (async function* () {
          yield new Uint8Array(1801);
        })(),
        progress() {},
      },
      work,
    );
    expect(commands.filter((command) => command === 0x98)).toHaveLength(1);
    expect(commands.filter((command) => command === 0x93)).toHaveLength(
      point === "before-chunk" ? 0 : 1,
    );
    expect(result.error).not.toBeNull();
    if (point === "close-fails") {
      expect(result.dispatch).toBe("unknown");
      expect(result.error?.message).toContain("close failed");
    }
    const count = commands.length;
    await provider.legacy(
      connection.value!.key,
      { kind: "delete", remotePath: "/home/root/lms2012/prjs/helper.rbf" },
      work,
    );
    expect(commands).toHaveLength(count); // cleanup rights cannot authorize helper deletion
  },
);
it.each([1500, 60000])(
  "AM-08 captures non-default Wi-Fi timeouts and clamps to %i",
  async (budget) => {
    const descriptor = {
      id: "wifi:test",
      name: "Brick",
      transport: "wifi" as const,
      address: "192.0.2.1",
    };
    const raw = new EV3DeviceSession(descriptor, {
      exchange: async () => Uint8Array.of(2),
      transmit: async () => {},
      close: async () => {},
    });
    const connect = vi.fn(async () => raw);
    const policy = vi.fn(() => ({
      wifiConnectTimeoutMs: 30000 as const,
      wifiHandshakeTimeoutMs: 10000 as const,
      usbAutoReconnect: true,
      usbRetryInterval: 2000 as const,
      usbRetryLimit: 3 as const,
    }));
    const provider = buildEv3Provider(
      { identify: () => randomUUID(), connectionPolicy: policy },
      {
        usb: { discover: async () => [], connect },
        wifi: { discover: async () => [], connect },
      },
    );
    const work: ProviderOperationContext = { ...ctx(), deadlineMonotonicMs: budget };
    work.exchange = async (_step, invoke) => invoke(new AbortController().signal, budget);
    expect((await provider.connect({ wifiAddress: descriptor.address }, work)).error).toBeNull();
    expect(policy).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ address: descriptor.address }),
      expect.any(AbortSignal),
      {
        connectTimeoutMs: Math.min(30000, budget),
        handshakeTimeoutMs: Math.min(10000, budget),
      },
    );
  },
);
it("AM-08 rejects expired candidate descriptors without reopening their native path", async () => {
  const descriptor = {
    id: "usb:stale",
    name: "Brick",
    transport: "usb" as const,
    serialNumber: "A",
    metadata: { path: "stale" },
  };
  const connect = vi.fn();
  const provider = buildEv3Provider(
    {
      identify: () => randomUUID(),
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 5000,
        wifiHandshakeTimeoutMs: 3000,
        usbAutoReconnect: true,
        usbRetryInterval: "backoff",
        usbRetryLimit: "unlimited",
      }),
    },
    {
      usb: { discover: async () => [descriptor], connect },
      wifi: { discover: async () => [], connect },
    },
  );
  const found = await provider.discover(ctx());
  const later = ctx();
  later.now = () => 30001;
  expect((await provider.connect(found.value![0]!.key, later)).error).not.toBeNull();
  expect(connect).not.toHaveBeenCalled();
});

it("AM-06 read and mode-change snapshots both use the unpublished zero sentinel", async () => {
  const descriptor = {
    id: "usb:sample",
    name: "Brick",
    transport: "usb" as const,
    serialNumber: "sample",
  };
  const reading = {
    sampledAt: 123456,
    battery: { percent: 80, voltage: 7.5 },
    program: { status: "stopped" as const, rawStatus: 64, result: 0 },
    inputs: [
      {
        port: 0,
        type: 29,
        connection: 122,
        mode: 0,
        state: "ready" as const,
        name: "Touch",
        modeName: "Touch",
        unit: "raw",
        decimals: 0,
        values: [1],
        switchable: true,
      },
    ],
    outputs: Array.from({ length: 4 }, (_, port) => ({
      port,
      type: 7,
      state: "ready" as const,
      name: "Motor",
      angle: 0,
    })),
  };
  const raw = new EV3DeviceSession(descriptor, {
    exchange: async () => Uint8Array.of(2),
    transmit: async () => {},
    close: async () => {},
  });
  vi.spyOn(raw, "bindIo").mockReturnValue(raw);
  vi.spyOn(raw, "readMonitor").mockResolvedValue(reading);
  vi.spyOn(raw, "setInputMode").mockResolvedValue(reading);
  const transport = { discover: async () => [descriptor], connect: async () => raw };
  const handles = new Map<string, string>();
  const provider = buildEv3Provider(
    {
      connectionPolicy: () => ({
        wifiConnectTimeoutMs: 5000,
        wifiHandshakeTimeoutMs: 3000,
        usbAutoReconnect: true,
        usbRetryInterval: "backoff",
        usbRetryLimit: "unlimited",
      }),
      identify(value) {
        const key = JSON.stringify(value);
        if (!handles.has(key)) handles.set(key, randomUUID());
        return handles.get(key)!;
      },
    },
    { usb: transport, wifi: transport },
  );
  const candidates = await provider.discover(ctx());
  const connection = await provider.connect(candidates.value![0]!.key, ctx());
  const work = ctx(randomUUID());
  const sources = await provider.sources(connection.value!.key, work);
  const read = await provider.read(connection.value!.key, work);
  expect(read.value).toMatchObject({ sequence: 0, sampledAt: 0, elapsedMs: 0 });
  const changed = await provider.setInputMode(
    connection.value!.key,
    {
      portId: "input:0",
      modeId: "mode:0",
      expectedSourceRevision: sources.value!.sourceRevision,
    },
    work,
  );
  expect(changed.value?.snapshot.frame).toMatchObject({ sequence: 0, sampledAt: 0, elapsedMs: 0 });
});
