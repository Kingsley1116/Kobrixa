import { describe, it, expect, vi } from "vitest";
import {
  pluginManifestSchema,
  deviceDeclarationProblems,
  uiDeclarationProblems,
  contextCommandDeclarationSchema,
  validateUiResourceV2,
  uiBytes,
  settingsResourceV1Schema,
  type DeviceSessionSnapshot,
  type SourceCatalog,
  type ReadSnapshot,
} from "@kobrixa/plugin-protocol";
import {
  fresh,
  readings,
  recoveryText,
} from "../../../../../plugins/device-ev3/src/presentation.js";
import manifestRaw from "../../../../../plugins/device-ev3/kobrixa-plugin.json";
import panel from "../../../../../plugins/device-ev3/ui/panel.json";
import prefs from "../../../../../plugins/device-ev3/settings/preferences.json";
const id = "00000000-0000-4000-8000-000000000001";
const session: DeviceSessionSnapshot = {
  sessionId: id,
  providerId: "kobrixa.device-ev3",
  providerGeneration: 1,
  revision: 1,
  name: "EV3",
  transport: "usb",
  capabilities: ["telemetry.v1"],
  state: "connected",
  foreground: "none",
  recording: false,
  sourceRevision: 1,
};
const sources: SourceCatalog = {
  sessionId: id,
  sourceRevision: 1,
  actuators: [],
  channels: [
    {
      channelId: id,
      kind: "input",
      portId: "input:0",
      typeId: "29",
      modeId: "0",
      component: 0,
      name: "Color",
      modeName: "Reflect",
      unit: "pct",
      decimals: 0,
      state: "ready",
    },
  ],
};
const sample = (ageMs: number | null = 0): ReadSnapshot => ({
  sessionId: id,
  revision: 1,
  status: "fresh",
  ageMs,
  frame: {
    sequence: 1,
    sampledAt: 10000,
    elapsedMs: 0,
    sourceRevision: 1,
    status: "ok",
    values: [{ channelId: id, value: 38 }],
    program: "stopped",
  },
});
describe("E4 public resources", () => {
  it("validates actual manifest and v2 resources with the original factory claim", () => {
    const m = pluginManifestSchema.parse(manifestRaw);
    expect(deviceDeclarationProblems(m)).toEqual([]);
    expect(uiDeclarationProblems(m)).toEqual([]);
    expect(m.runtime.kind).toBe("node");
    expect(m.contributes?.deviceProviders).toEqual([
      {
        id: "kobrixa.device-ev3",
        capabilities: [
          "connection.v1",
          "telemetry.v1",
          "inputModes.v1",
          "finiteMotion.v1",
          "recordingReservation.v1",
        ],
      },
    ]);
    expect(
      validateUiResourceV2(
        panel,
        {
          pluginId: m.id,
          commands: m.contributes!.commands!.map((c) => contextCommandDeclarationSchema.parse(c)),
          panels: m.contributes!.panels!,
        },
        uiBytes(panel),
      ),
    ).toMatchObject({ ok: true });
  });
  it("preserves nine-field settings validation and dependent reset semantics", () => {
    const resource = settingsResourceV1Schema.parse(prefs);
    expect(resource.fields).toHaveLength(9);
    expect(resource.fields.find((f) => f.key === "lastWifiAddress")).toMatchObject({
      maxLength: 45,
      maxBytes: 180,
      resetWhen: { key: "rememberWifiAddress", equals: false },
    });
    expect(resource.fields.every((f) => f.label["zh-TW"])).toBe(true);
    expect(resource.fields.map((f) => [f.key, f.default])).toEqual([
      ["skipUnchangedAssets", true],
      ["usbAutoReconnect", true],
      ["usbRetryInterval", "backoff"],
      ["usbRetryLimit", "unlimited"],
      ["wifiConnectTimeout", 5000],
      ["wifiHandshakeTimeout", 3000],
      ["connectionMode", "usb"],
      ["rememberWifiAddress", false],
      ["lastWifiAddress", ""],
    ]);
  });
  it("routes disconnect/recovery only through trusted core actions", () => {
    expect(
      panel.nodes
        .filter((n) => "action" in n && n.action?.kind === "core")
        .map((n) => ("action" in n ? n.action?.action : undefined)),
    ).toEqual(["disconnect", "openRecovery", "cancelConnectionRecovery"]);
  });
});
describe("independent E0 P07–P10 expected behavior (not full DOM parity)", () => {
  it.each([
    [-1, false],
    [0, true],
    [2500, true],
    [2501, false],
  ] as const)("freshness boundary %s ms", (age, expected) => {
    expect(fresh(session, sources, sample(age), 0, 0)).toBe(expected);
  });
  it("ages at the client, rejects mismatched source/session, busy and recording", () => {
    expect(fresh(session, sources, sample(), 0, 2501)).toBe(false);
    expect(fresh({ ...session, foreground: "file" }, sources, sample(), 0, 0)).toBe(false);
    expect(fresh({ ...session, recording: true }, sources, sample(), 0, 0)).toBe(false);
    expect(fresh(session, { ...sources, sourceRevision: 2 }, sample(), 0, 0)).toBe(false);
    expect(fresh(session, sources, { ...sample(), sessionId: "other" }, 0, 0)).toBe(false);
  });
  it("keeps null readings unavailable, preserves units/age and marks foreground waiting", () => {
    expect(readings(sources, sample(), 0, 500)[0]?.cells).toEqual([
      "input:0",
      "ready",
      "38",
      "pct",
      "500",
    ]);
    const r = sample();
    r.frame!.values[0]!.value = null;
    expect(readings(sources, r, 0, 0)[0]?.cells[2]).toBe("Unavailable");
    expect(readings(sources, { ...r, status: "busy" }, 0, 0)[0]?.cells[2]).toBe("Waiting");
    expect(readings(sources, r, 0, 2501)[0]?.cells[2]).toBe("Unavailable");
  });
  it("shows retained cancellation failure and retry exhaustion without creating intent", () => {
    expect(
      recoveryText({
        hostEpoch: id,
        revision: 1,
        recovery: {
          recoveryId: id,
          providerId: "kobrixa.device-ev3",
          providerGeneration: 1,
          previousSessionId: id,
          name: "EV3",
          attemptsStarted: 3,
          retryLimit: 3,
          phase: "retry-exhausted",
        },
      }),
    ).toContain("retry-exhausted");
  });
});

it("P08: all eight port positions remain visible without inventing missing input state", () => {
  const rows = readings(sources, sample(), 0, 0);
  for (const port of [
    "input:0",
    "input:1",
    "input:2",
    "input:3",
    "output:0",
    "output:1",
    "output:2",
    "output:3",
  ])
    expect(rows.some((r) => r.cells[0] === port)).toBe(true);
  expect(rows.find((r) => r.key === "input:1")?.cells).toEqual([
    "input:1",
    "unavailable",
    "Unavailable",
    "",
    "Unknown",
  ]);
});
it("P07: null battery percent/voltage remain unavailable rather than zero", () => {
  const battery: SourceCatalog = {
    ...sources,
    channels: [{ ...sources.channels[0]!, kind: "battery-percent", portId: null, unit: "%" }],
  };
  const read = sample();
  read.frame!.values[0]!.value = null;
  expect(readings(battery, read, 0, 0)[0]?.cells).toEqual([
    "battery-percent",
    "ready",
    "Unavailable",
    "%",
    "0",
  ]);
});

import { DeviceController } from "../../../../../plugins/device-ev3/src/controller.js";
const ok = (value: unknown) => ({ ok: true, value });
it("delayed recovery adoption must survive a later session-source refresh", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const disposed: string[] = [];
  let sourceRevision = 1;
  const session = () => ({
    sessionId: "session",
    providerId: "kobrixa.device-ev3",
    state: "connected",
    sourceRevision,
  });
  const ctx = {
    devices: {
      subscribe: vi.fn(async (p: { topic: string }) => {
        if (p.topic === "connectionRecovery") await wait;
        return ok({
          subscriptionId: p.topic,
          dispose: async () => {
            disposed.push(p.topic);
            return ok({ removed: true });
          },
        });
      }),
      connectionRecovery: {
        read: async () => ok({ hostEpoch: "host", revision: 0, recovery: null }),
      },
      list: async () => ok({ revision: sourceRevision, sessions: [session()] }),
      session: async () =>
        ok({
          session: session(),
          sources: { sessionId: "session", sourceRevision, channels: [], actuators: [] },
        }),
    },
    settings: {
      watch: async () => ok({ subscriptionId: "settings" }),
      read: async () => ok({ schemaVersion: 1, revision: null, values: [] }),
    },
  };
  const c = new DeviceController(ctx as never) as unknown as {
    startObservation(): Promise<void>;
    refresh(owner: AbortController): Promise<void>;
    observing: AbortController;
  };
  const started = c.startObservation();
  await vi.waitFor(() =>
    expect(ctx.devices.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "connectionRecovery" }),
      expect.any(Function),
      expect.any(AbortSignal),
    ),
  );
  await c.refresh(c.observing);
  release();
  await started;
  sourceRevision = 2;
  await c.refresh(c.observing);
  // Only session-scoped observation should retire; recovery is process-wide.
  expect(disposed).not.toContain("connectionRecovery");
});
it("a form event during initial state read must not lose visible-panel admission", async () => {
  let deliver!: (event: unknown) => void;
  let release!: (state: unknown) => void;
  const pending = new Promise((r) => {
    release = r;
  });
  const binding = {
    contributionId: "kobrixa.device-ev3.panel",
    kind: "panel",
    panelInstance: "panel",
    generation: 1,
    uiResourceGeneration: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const state = vi.fn(() => pending);
  const ctx = {
    ui: {
      subscribe: async (_p: unknown, listener: (e: unknown) => void) => {
        deliver = listener;
        return ok({ subscriptionId: "ui" });
      },
      state,
    },
  };
  const c = new DeviceController(ctx as never) as unknown as {
    instances(b: unknown[]): Promise<void>;
    views: Map<string, { visible: boolean; form: unknown }>;
  };
  const started = c.instances([binding]);
  await vi.waitFor(() => expect(state).toHaveBeenCalledOnce());
  deliver({ kind: "ui.form", data: { binding, values: { transport: "wifi" }, revision: 1 } });
  release(ok({ visible: true, form: { transport: "wifi" }, formRevision: 1 }));
  await started;
  expect([...c.views.values()][0]!.visible).toBe(true);
});

import { randomUUID } from "node:crypto";
import { Ev3Catalog } from "../../main/device-providers/ev3/catalog.js";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
it.each(["empty", "initializing", "unknown", "error", "ready"] as const)(
  "P08 consumes actual zero-value %s catalog metadata without inventing a measurement",
  (state) => {
    const catalog = new Ev3Catalog(
      {
        identify: () => randomUUID(),
        connectionPolicy: () => ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: false,
          usbRetryInterval: 1000,
          usbRetryLimit: 3,
        }),
      },
      id,
    );
    const observed: DeviceMonitorSnapshot = {
      sampledAt: 0,
      battery: { percent: null, voltage: null },
      program: { status: "unknown", rawStatus: 0, result: 0 },
      outputs: Array.from({ length: 4 }, (_, port) => ({
        port,
        type: 126,
        state: "empty" as const,
        name: "",
        angle: null,
      })),
      inputs: [
        {
          port: 0,
          type: 126,
          connection: 126,
          mode: 0,
          state,
          name: "Input 1",
          modeName: "",
          unit: "",
          decimals: 0,
          values: [],
          switchable: false,
        },
      ],
    };
    const sources = catalog.accept(observed),
      frame = catalog.frame(observed);
    const input = sources.channels.find((c) => c.portId === "input:0")!;
    expect(input).toMatchObject({ component: 0, state, typeId: "ev3:126" });
    expect(frame.values.find((v) => v.channelId === input.channelId)?.value).toBeNull();
    expect(
      readings(
        sources,
        { sessionId: id, revision: 1, status: "fresh", ageMs: 0, frame },
        0,
        0,
      ).find((r) => r.key === input.channelId)?.cells,
    ).toEqual(["input:0", state === "unknown" ? "unsupported" : state, "Unavailable", "", "0"]);
  },
);

it.each([
  [{}, false, false],
  [{ transport: "wifi" }, true, false],
  [{ "wifi-address": "192.168.1.2" }, true, false],
  [{ port: "input:1" }, false, true],
] as const)(
  "E6: form delta %j invalidates only its dependent rows",
  async (change, connectionChanged, portChanged) => {
    let deliver!: (event: unknown) => void;
    const binding = {
      contributionId: "kobrixa.device-ev3.panel",
      kind: "panel",
      panelInstance: "panel",
      generation: 1,
      uiResourceGeneration: 1,
      hostEpoch: "host",
      processEpoch: "process",
    };
    const original = { transport: "usb", "wifi-address": "", port: "input:0" };
    const controller = new DeviceController({
      ui: {
        subscribe: async (_p: unknown, listener: (event: unknown) => void) => {
          deliver = listener;
          return ok({ subscriptionId: "ui" });
        },
        state: async () => ok({ visible: false, form: original, formRevision: 1 }),
      },
    } as never) as unknown as {
      instances(b: unknown[]): Promise<void>;
      views: Map<
        string,
        {
          form: Record<string, unknown>;
          formRevision: number;
          candidates: unknown[];
          modes: unknown[];
          revisions: Map<string, number>;
          discovery: number;
          modeIdentity: string;
          dirty: boolean;
          phase: string;
        }
      >;
    };
    await controller.instances([binding]);
    const view = [...controller.views.values()][0]!;
    view.candidates = [{ candidateId: "original" }];
    view.modes = [{ key: "original" }];
    view.revisions = new Map([
      ["candidates", 11],
      ["modes", 12],
    ]);
    view.discovery = 7;
    view.modeIdentity = "session:1:input:0";
    view.dirty = false;
    view.phase = "Choose";
    const candidates = view.candidates,
      modes = view.modes;
    deliver({
      kind: "ui.form",
      data: { binding, revision: 2, values: { ...original, ...change } },
    });
    expect(view.formRevision).toBe(2);
    expect(view.discovery).toBe(connectionChanged ? 8 : 7);
    expect(view.candidates).toEqual(connectionChanged ? [] : candidates);
    expect(view.modes).toEqual(portChanged ? [] : modes);
    expect(view.revisions.get("candidates")).toBe(connectionChanged ? undefined : 11);
    expect(view.revisions.get("modes")).toBe(portChanged ? undefined : 12);
    expect(view.modeIdentity).toBe(portChanged ? "" : "session:1:input:0");
    expect(view.dirty).toBe(connectionChanged || portChanged);
    if (!connectionChanged) expect(view.phase).toBe("Choose");
    const accepted = structuredClone(view.form);
    deliver({
      kind: "ui.form",
      data: {
        binding,
        revision: 1,
        values: { transport: "wifi", port: "input:3", "wifi-address": "old" },
      },
    });
    expect(view.form).toEqual(accepted);
    expect(view.formRevision).toBe(2);
  },
);
