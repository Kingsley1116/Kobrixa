import { test } from "node:test";
import assert from "node:assert/strict";
import {
  devicePanelStep,
  observeCandidatePublication,
  matchDiscoveryWire,
  matchSelectedRow,
} from "./ev3-uhid-device.mjs";

const commandReply = {
  ok: true,
  value: { kind: "command", invocationId: "one", value: { fieldErrors: [] } },
};
const staleReply = {
  ok: false,
  error: {
    code: "PLUGIN_E_STALE_RESOURCE",
    detail: { kind: "resource", reason: "stale", resource: "ui-binding" },
  },
};

test("only the armed original panel and matching revision can supply the candidate key", async () => {
  let notify;
  const pages = [];
  const observation = observeCandidatePublication(
    {
      onEvent(f) {
        notify = f;
        return () => {};
      },
      dataRead(args) {
        return new Promise((resolve) => pages.push({ args, resolve }));
      },
    },
    "fixture",
  );
  const binding = { contributionId: "kobrixa.device-ev3.panel", panelInstance: "original" };
  const event = { binding, type: "data", dataset: "candidates", revision: 1, presentation: 1 };
  notify(event);
  observation.arm();
  observation.command({ ...binding, panelInstance: "foreign" }, undefined);
  notify(event);
  assert.equal(pages.length, 0);
  observation.command(binding, undefined);
  observation.command(binding, {
    ok: true,
    value: { kind: "command", invocationId: "call", value: { fieldErrors: [] } },
  });
  notify({ ...event, binding: { ...binding, panelInstance: "other" } });
  assert.equal(pages.length, 0);
  notify(event);
  notify({ ...event, revision: 2 });
  const row = { key: "id", cells: ["fixture", "usb"] };
  const reply = (revision) => ({
    ok: true,
    value: { revision, presentation: 1, chunk: { kind: "table", entries: [row] }, done: true },
  });
  pages[0].resolve(reply(1));
  await Promise.resolve();
  assert.equal(observation.status().candidate, undefined);
  pages[1].resolve(reply(2));
  await Promise.resolve();
  assert.deepEqual(observation.status().candidate, row);
  notify({ ...event, revision: 3 });
  pages[2].resolve(reply(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(observation.status().error, /does not match/);
  assert.equal(observation.status().candidate, undefined);
});

test("selection requires the published key and original candidate version", async () => {
  const { runInNewContext } = await import("node:vm");
  let clicks = 0,
    label = "Select: other",
    selected;
  const button = {
    disabled: false,
    getClientRects: () => [{}],
    getAttribute: () => label,
    click: () => {
      clicks++;
    },
  };
  const candidate = { key: "id", version: "1" };
  const row = {
    cells: [{ textContent: "fixture" }, { textContent: "usb" }],
    textContent: "fixture usb",
    querySelector: () => button,
  };
  const pane = { querySelectorAll: () => [row] };
  let rendererReply = commandReply;
  const ctx = {
    document: { querySelector: () => pane },
    window: {
      __uhidDiscovery: {
        status: () => ({ candidate, selected, reply: rendererReply }),
        rendered: () => {
          selected = { ...candidate };
        },
      },
    },
  };
  const run = (step) =>
    runInNewContext(`(${devicePanelStep.toString()})("${step}","fixture")`, ctx);
  assert.equal(run("candidate"), undefined);
  label = "Select: id";
  assert.equal(run("candidate"), "fixture usb");
  rendererReply = staleReply;
  assert.equal(run("candidate"), "fixture usb");
  candidate.version = "2";
  assert.equal(run("select"), false);
  assert.equal(clicks, 0);
  candidate.version = "1";
  assert.equal(run("select").key, candidate.key);
  assert.equal(clicks, 1);
});

test("command probes read the original action and reply without stopping execution", async () => {
  const { discoveryCommandSites } = await import("./ev3-uhid-device.mjs");
  const { Session } = await import("node:inspector/promises");
  const c = new Session();
  c.connect();
  const code =
    '(async function(state,bridge,data,action,view){this.state=state;this.bridge=bridge;this.data=data;const s=this.state.getSnapshot();const result=await this.state.actionReply(this.bridge.interact({...action,...this.state.form(),presentation:this.data.getSnapshot().presentation,viewGeneration:view.generation}));if(!this.state.alive)return;return result}).call({}, {alive:true,getSnapshot:()=>({snapshot:{binding:"b"}}),actionReply:x=>x,form:()=>({})},{interact:async()=>({ok:true})},{getSnapshot:()=>({presentation:1})},{nodeId:"discover-action"},{generation:1})';
  const seen = [];
  globalThis.__uhidDiscovery = { command: (...args) => seen.push(args) };
  try {
    await c.post("Runtime.enable");
    await c.post("Debugger.enable");
    const { scriptId } = await c.post("Runtime.compileScript", {
      expression: code,
      sourceURL: "discovery-unit.js",
      persistScript: true,
    });
    for (const { start, end, condition } of discoveryCommandSites(code)) {
      const { locations } = await c.post("Debugger.getPossibleBreakpoints", {
        start: { scriptId, ...start },
        end: { scriptId, ...end },
      });
      assert.ok(locations.length);
      const { lineNumber, columnNumber } = locations[0];
      await c.post("Debugger.setBreakpoint", {
        location: { scriptId, lineNumber, columnNumber },
        condition,
      });
    }
    await c.post("Runtime.runScript", { scriptId, awaitPromise: true });
    assert.deepEqual(seen, [
      ["b", undefined],
      ["b", { ok: true }],
    ]);
    assert.equal(discoveryCommandSites("void 0"), null);
    assert.throws(() => discoveryCommandSites(code + code), /Ambiguous/);
  } finally {
    c.disconnect();
    delete globalThis.__uhidDiscovery;
  }
});

function discoveryFixture(reply = commandReply) {
  const binding = { panelInstance: "panel" };
  const status = {
    binding,
    reply,
    selected: { key: "usb1", publication: { binding, revision: 2 } },
  };
  const candidate = { candidateId: "usb1", name: "fixture", transport: "usb" };
  const row = (direction, message) => ({
    direction,
    message,
    owner: { processEpoch: "generation" },
    utility: 42,
  });
  const command = row("host-plugin", {
    id: 1,
    method: "command/invoke",
    params: { command: "kobrixa.device-ev3.discover", invocationId: "one", context: { binding } },
  });
  const query = row("plugin-host", { id: 1, method: "devices/discover" });
  const answer = row("host-plugin", {
    id: 1,
    result: { ok: true, value: { candidates: [candidate] } },
  });
  const end = row("plugin-host", {
    id: 1,
    result: { ok: true, value: { output: {}, fieldErrors: [] } },
  });
  const verify = (rows) => matchDiscoveryWire(rows, status, "fixture");
  return {
    command,
    query,
    answer,
    end,
    candidate,
    status,
    verify,
    rows: [command, query, answer, end],
  };
}

test("joins the returned USB candidate on the invoking process and command interval", () => {
  const { command, query, answer, end, candidate, status, verify, rows } = discoveryFixture();
  const result = verify(rows);
  assert.deepEqual(result.candidate, candidate);
  assert.equal(result.rendererReply, "command");
  assert.throws(
    () => verify([command, query, { ...answer, utility: 43 }, end]),
    /devices\/discover reply/,
  );
  assert.throws(() => verify([command, query, end, answer]), /devices\/discover reply/);
  status.selected.key = "other";
  assert.throws(() => verify([command, query, answer, end]), /matching published/);
});

test("stale UI binding after successful dispatch requires the published and rendered candidate", () => {
  const { rows, status, verify } = discoveryFixture(staleReply);
  const result = verify(rows);
  assert.equal(result.rendererReply, "stale-after-dispatch");
  assert.equal(result.invocationId, "one");
  status.selected.key = "other";
  assert.throws(() => verify(rows), /matching published/);
  delete status.selected;
  assert.throws(() => verify(rows), /published candidate and matching rendered row/);
});

test("stale UI binding without a unique original dispatch fails", () => {
  const { command, query, answer, end, verify, rows } = discoveryFixture(staleReply);
  assert.throws(() => verify([query, answer, end]), /original Discover invocation/);
  assert.throws(() => verify([...rows, command]), /original Discover invocation/);
});

test("stale UI binding cannot mask a failed plugin reply or command field errors", () => {
  const { end, verify, rows } = discoveryFixture(staleReply);
  end.message.result = { ok: false, error: { code: "PLUGIN_E_INTERNAL" } };
  assert.throws(() => verify(rows), /original Discover command reply.*PLUGIN_E_INTERNAL/);
  end.message.result = { ok: true, value: { fieldErrors: [{ field: "port" }] } };
  assert.throws(() => verify(rows), /original Discover command fieldErrors/);
});

test("the renderer observer retains the first failure and only allows the specific stale reply", () => {
  let notify;
  const observation = observeCandidatePublication({ onEvent: (f) => (notify = f) }, "fixture");
  const binding = { contributionId: "kobrixa.device-ev3.panel", panelInstance: "original" };
  notify({ binding });
  observation.arm();
  observation.command(binding, undefined);
  observation.command(binding, staleReply);
  assert.equal(observation.status().error, undefined);
  const failure = { ok: false, error: { code: "PLUGIN_E_INTERNAL" } };
  observation.command(binding, failure);
  observation.command(binding, staleReply);
  assert.match(observation.status().error, /Discover command failed.*PLUGIN_E_INTERNAL/);
  for (const reply of [
    failure,
    {
      ok: false,
      error: { ...staleReply.error, detail: { ...staleReply.error.detail, resource: "dataset" } },
    },
    { ok: true, value: { ...commandReply.value, value: { fieldErrors: [{ field: "port" }] } } },
  ]) {
    const { verify, rows } = discoveryFixture(reply);
    assert.throws(() => verify(rows), /Discover command failed/);
  }
});

test("renderer and wire invocation IDs must agree and cannot hide a second dispatch", () => {
  const { rows, command, verify } = discoveryFixture();
  const other = structuredClone(command);
  other.message.params.invocationId = "other";
  assert.throws(() => verify([other, ...rows.slice(1)]), /invocationId mismatch/);
  assert.throws(() => verify([...rows, other]), /original Discover invocation/);
});

test("a stale DOM row with the same key cannot attest a newer publication", () => {
  const binding = { panelInstance: "device" },
    selected = { key: "usb", version: "1", publication: { binding, revision: 2 } };
  const params = {
    command: "kobrixa.device-ev3.candidate",
    context: { binding },
    arguments: { key: "usb", version: "1", dataset: 1 },
    invocationId: "select",
  };
  const rows = [{ direction: "host-plugin", message: { method: "command/invoke", params } }];
  assert.throws(() => matchSelectedRow(rows, selected), /observed candidates revision/);
  params.arguments.dataset = 2;
  assert.equal(matchSelectedRow(rows, selected).invocationId, "select");
});
