import { expect, it, vi } from "vitest";
import { UiClient } from "./ui.js";
import * as commonEvents from "./events.js";
it("U06 rejects use before ready instead of waiting inside activate", async () => {
  const request = vi.fn(async () => ({ ok: true, value: { instances: [] } }));
  const ui = new UiClient(request as never, { adopt: vi.fn(), forget: vi.fn() });
  await expect(ui.instances()).rejects.toThrow("not ready");
  expect(request).not.toHaveBeenCalled();
  ui.markReady();
  expect(await ui.instances()).toMatchObject({ ok: true });
});
it("U08 adopts subscriptions in the common event client and exposes shared unsubscribe result", async () => {
  const begin = vi.spyOn(commonEvents, "beginUiSubscription").mockReturnValue(() => {});
  try {
    const adopt = vi.fn();
    const forget = vi.fn();
    const subscriptionId = "00000000-0000-4000-8000-000000000001";
    const request = vi.fn(async (method: string) =>
      method === "ui/subscribe"
        ? {
            ok: true,
            value: {
              subscriptionId,
              sequence: 0,
              snapshot: { instances: [], states: [], locale: "en", theme: "light" },
            },
          }
        : { ok: true, value: { removed: true } },
    );
    const ui = new UiClient(request as never, { adopt, forget });
    ui.markReady();
    const callback = vi.fn();
    expect((await ui.subscribe({ topics: ["instances"] }, callback)).ok).toBe(true);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(await ui.unsubscribe(subscriptionId)).toMatchObject({
      ok: true,
      value: { removed: true },
    });
    expect(request).toHaveBeenLastCalledWith(
      "events/unsubscribe",
      { subscriptionId },
      expect.anything(),
    );
    expect(forget).toHaveBeenCalledWith(subscriptionId);
  } finally {
    begin.mockRestore();
  }
});

import {
  RpcPeer,
  createMemoryChannelPair,
  type UiEventEnvelope,
  type ResourceOwner,
} from "@kobrixa/plugin-protocol";
import { uiEventClientPort, bindEventChannel } from "./events.js";
it("U08 acknowledges bounded enqueue before callback and survives callback failure", async () => {
  const [hostEnd, pluginEnd] = createMemoryChannelPair();
  const host = new RpcPeer(hostEnd);
  const plugin = new RpcPeer(pluginEnd);
  const subscriptionId = "00000000-0000-4000-8000-000000000001";
  const owner: ResourceOwner = {
    sourceKey: "builtin:test.ui",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: "00000000-0000-4000-8000-000000000002",
    processEpoch: "00000000-0000-4000-8000-000000000003",
  };
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.handle("ui/subscribe", async () => ({
    ok: true,
    value: {
      subscriptionId,
      sequence: 0,
      snapshot: { instances: [], states: [], locale: "en", theme: "light" },
    },
  }));
  host.handle("events/ack", async ({ sequence }) => {
    order.push(`ack:${sequence}`);
    return { ok: true as const, value: { acknowledged: sequence } };
  });
  host.handle("events/unsubscribe", async () => ({ ok: true as const, value: { removed: true } }));
  bindEventChannel(plugin, owner);
  const ui = new UiClient(plugin.request.bind(plugin), uiEventClientPort(plugin));
  ui.markReady();
  try {
    await ui.subscribe({ topics: ["environment"] }, async (event) => {
      order.push(`callback:${event.sequence}`);
      if (event.sequence === 1) {
        await gate;
        throw new Error("Callback failure is isolated.");
      }
    });
    const event = (sequence: number): UiEventEnvelope => ({
      version: 1,
      subscriptionId,
      owner,
      sequence,
      delivery: "control",
      kind: "ui.environment",
      data: { locale: "en", theme: "dark" },
    });
    host.notify("events/deliver", event(1));
    await vi.waitFor(() => expect(order).toContain("callback:1"));
    expect(order.indexOf("ack:1")).toBeLessThan(order.indexOf("callback:1"));
    host.notify("events/deliver", event(2));
    await vi.waitFor(() => expect(order).toContain("ack:2"));
    release();
    await vi.waitFor(() => expect(order).toContain("callback:2"));
    expect(order.filter((value) => value === "callback:1")).toHaveLength(1);
    await ui.unsubscribe(subscriptionId);
  } finally {
    release();
    host.close();
    plugin.close();
  }
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  uiResourceV1Schema,
  validateUiResource,
  uiFailure,
  type ContextCommandDeclaration,
} from "@kobrixa/plugin-protocol";
it("matches Zod, exported JSON Schema and Python semantics on every materialized UI fixture", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const records = ["valid", "invalid", "maximum"].flatMap(
    (name) =>
      JSON.parse(
        readFileSync(
          new URL(
            `../../plugin-protocol/test-fixtures/declarative-ui-v1/${name}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ).cases,
  );
  const python = spawnSync(
    "python3",
    [
      "-c",
      `
import json, sys
from kobrixa._schema import Validator, SchemaError
from kobrixa._ui import validate_resource
rows = []
for record in json.load(sys.stdin):
    case = record["input"]
    try:
        Validator.bundled().validate("ui-resource-v1", case["resource"])
        structural = True
    except SchemaError:
        structural = False
    try:
        validate_resource(case["resource"], {"pluginId":"acme.ui", "commands":case["commands"], "panels":[{"id":p} for p in case["panels"]]}, case["rawBytes"], case["version"])
        rows.append({"structural":structural,"valid":True,"businessCode":None,"reason":None})
    except SchemaError as error:
        rows.append({"structural":structural,"valid":False,"businessCode":error.business_code,"reason":error.reason})
print(json.dumps(rows))
`,
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: `${root}/sdks/python` },
      input: JSON.stringify(records),
      encoding: "utf8",
    },
  );
  expect(python.status, python.stderr).toBe(0);
  const outcomes = JSON.parse(python.stdout);
  records.forEach((record, index) => {
    const fixture = record.input;
    const context = {
      pluginId: "acme.ui",
      commands: fixture.commands as ContextCommandDeclaration[],
      panels: fixture.panels.map((id: string) => ({
        id,
        title: { en: "Panel" },
        location: "right" as const,
        resource: { version: 1, path: "panel.json" },
      })),
    };
    const result =
      fixture.version === 1
        ? validateUiResource(fixture.resource, context, fixture.rawBytes)
        : uiFailure("version");
    expect(result.ok, record.id).toBe(record.valid);
    expect(outcomes[index], record.id).toEqual({
      structural: uiResourceV1Schema.safeParse(fixture.resource).success,
      valid: result.ok,
      businessCode: result.ok ? null : result.error.code,
      reason: result.ok ? null : result.error.detail?.reason,
    });
    if (!result.ok) {
      expect(result.error.code, record.id).toBe(record.expected.businessCode);
      expect(result.error.detail?.reason, record.id).toBe(record.expected.reason);
    }
  });
});
