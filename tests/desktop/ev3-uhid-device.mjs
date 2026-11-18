import assert from "node:assert/strict";
import { constants } from "node:fs";
import path from "node:path";
import { access, readFile, stat } from "node:fs/promises";
import { until } from "./builtin-installed-client.mjs";
// Locate the renderer's original action IPC call and its awaited continuation.
// The cursor path has a different presentation source. Reject ambiguous builds.
export function discoveryCommandSites(source) {
  const pattern =
    /(?:\blet|\bconst)\s+(\w+)\s*=\s*this\.state\.getSnapshot\(\)\s*[,;]\s*(?:(?:let|const)\s+)?(\w+)\s*=\s*await\s+this\.state\.actionReply\(\s*this\.bridge\.interact\(\s*\{\s*\.\.\.(\w+),\s*\.\.\.this\.state\.form\(\),[^;]*?presentation:\s*this\.data\.getSnapshot\(\)\.presentation,\s*viewGeneration:\s*\w+\.generation,?\s*\}\s*\),?\s*\);\s*if\s*\(/g;
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error("Ambiguous renderer action observation site");
  const [m] = matches;
  const location = (offset) => {
    const lines = source.slice(0, m.index + offset).split("\n");
    return { lineNumber: lines.length - 1, columnNumber: lines.at(-1).length };
  };
  const action = m[3],
    binding = m[1] + ".snapshot.binding";
  const record = (value) =>
    "(" +
    action +
    '.nodeId==="discover-action" && globalThis.__uhidDiscovery.command(' +
    binding +
    "," +
    value +
    "), false)";
  const call = m[0].indexOf("interact(");
  return [
    { start: location(call), end: location(call + 1), condition: record("undefined") },
    {
      start: location(m[0].lastIndexOf("if")),
      end: location(m[0].length + 24),
      condition: record(m[2]),
    },
  ];
}

async function observeDiscoveryCommand(client) {
  const scripts = [];
  const off = client.on("Debugger.scriptParsed", (s) => scripts.push(s));
  try {
    await client.send("Debugger.enable");
    let installed = false;
    for (const script of scripts.filter((s) => /\/assets\/index-[^/]+\.js$/.test(s.url))) {
      const { scriptSource } = await client.send("Debugger.getScriptSource", {
        scriptId: script.scriptId,
      });
      const sites = discoveryCommandSites(scriptSource);
      if (!sites) continue;
      if (installed) throw new Error("Multiple installed renderer action sites");
      for (const { start, end, condition } of sites) {
        const loc = (pos) => ({ scriptId: script.scriptId, ...pos });
        const { locations } = await client.send("Debugger.getPossibleBreakpoints", {
          start: loc(start),
          end: loc(end),
        });
        if (!locations.length) throw new Error("Missing installed renderer action breakpoint");
        const { scriptId, lineNumber, columnNumber } = locations[0];
        const location = { scriptId, lineNumber, columnNumber };
        const { actualLocation } = await client.send("Debugger.setBreakpoint", {
          location,
          condition,
        });
        if (
          actualLocation.lineNumber !== location.lineNumber ||
          actualLocation.columnNumber !== location.columnNumber
        )
          throw new Error("Renderer action observation moved");
      }
      installed = true;
    }
    if (!installed) throw new Error("Missing installed renderer action call site");
    return () => client.send("Debugger.disable");
  } catch (error) {
    await client.send("Debugger.disable");
    throw error;
  } finally {
    off();
  }
}

// Installed in the renderer before the Device tab is selected. Only product
// bridge events can identify the panel and candidate dataset publication.
export function observeCandidatePublication(ui, product) {
  let binding,
    armed = false,
    publication,
    candidate,
    error,
    selected,
    invoked = false,
    reply;
  const off = ui.onEvent((event) => {
    if (event.binding?.contributionId !== "kobrixa.device-ev3.panel") return;
    binding ??= event.binding;
    if (Object.keys(binding).some((key) => binding[key] !== event.binding[key])) return;
    if (!invoked || event.type !== "data" || event.dataset !== "candidates") return;
    const current = (publication = {
      binding,
      revision: event.revision,
      presentation: event.presentation,
    });
    candidate = undefined;

    const read = async () => {
      let offset = 0;
      for (;;) {
        const result = await ui.dataRead({
          binding,
          dataset: "candidates",
          revision: current.revision,
          offset,
          limit: 50,
        });
        if (publication !== current) return;
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        const page = result.value;
        if (
          page.revision !== current.revision ||
          page.presentation !== current.presentation ||
          page.chunk.kind !== "table"
        )
          throw new Error("Candidate page does not match publication");
        const row = page.chunk.entries.find((r) => r.cells[0] === product && r.cells[1] === "usb");
        if (row) {
          candidate = row;
          return;
        }
        if (page.done) return;
        if (!(page.nextOffset > offset)) throw new Error("Candidate page made no progress");
        offset = page.nextOffset;
      }
    };
    void read().catch((e) => {
      if (publication === current) error ??= String(e);
    });
  });
  return {
    arm() {
      armed = true;
    },
    command(original, result) {
      if (!armed || !binding || Object.keys(binding).some((key) => binding[key] !== original[key]))
        return;
      if (result === undefined) invoked = true;
      else if (invoked) {
        reply = result;
        if (
          !result.ok ||
          result.value.kind !== "command" ||
          !result.value.invocationId ||
          result.value.value.fieldErrors.length
        )
          error ??= "Discover command failed: " + JSON.stringify(result);
      }
    },
    rendered() {
      selected ??= { key: candidate.key, version: candidate.version, publication };
    },
    status: () => ({ binding, armed, invoked, reply, publication, candidate, selected, error }),
    dispose: off,
  };
}

// Runs in the inspected renderer. All actions go through the installed controls.
export function devicePanelStep(step, product) {
  const pane = document.querySelector(".plugin-tools-pane [role=tabpanel]");
  const click = (button) => {
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  };
  switch (step) {
    case "tools": {
      const toggle = document.querySelector(".plugin-tools-toggle");
      return toggle?.getAttribute("aria-pressed") === "true" || click(toggle);
    }
    case "device":
      return click(
        [...document.querySelectorAll(".plugin-tools-pane [role=tab]")].find((tab) =>
          ["EV3 device", "EV3 裝置"].includes(tab.title),
        ),
      );
    case "open":
      return click(pane?.querySelector(":scope > button:not([data-close-contribution])"));
    case "discover": {
      const observation = window.__uhidDiscovery;
      const button = pane?.querySelector('[data-ui-node="discover-action"] button');
      if (
        !observation.status().binding ||
        !button ||
        button.disabled ||
        !button.getClientRects().length
      )
        return false;
      if (
        !pane
          .querySelector('[data-ui-node="preferences"]')
          ?.textContent.includes("Preferences: host settings form")
      )
        return false;
      observation.arm();
      return click(button);
    }
    case "diagnostics": {
      const status = window.__uhidDiscovery.status();
      const { binding, armed, invoked, reply, publication, candidate, selected } = status;
      let missing = selected ? null : "exact rendered candidate row";
      if (!binding) missing = "original Device panel binding";
      else if (!armed) missing = "ready Discover control and settings";
      else if (!invoked) missing = "Discover IPC invocation";
      else if (!reply) missing = "Discover IPC reply";
      else if (!publication) missing = "post-click candidates publication";
      else if (!candidate) missing = "UHID candidate in published revision";
      return {
        missing,
        ...status,
        phase: pane?.querySelector('[data-ui-node="discovery"]')?.textContent,
        preferences: pane?.querySelector('[data-ui-node="preferences"]')?.textContent,
        productError: pane?.querySelector('[data-ui-node="error"]')?.textContent,
      };
    }
    case "refresh":
      return click(pane?.querySelector('[data-ui-node="refresh-action"] button'));
    case "candidate":
    case "select": {
      const { candidate, selected, publication, reply, error } = window.__uhidDiscovery.status();
      if (error) throw new Error(error);
      if (
        !reply?.ok ||
        !candidate ||
        (selected && (candidate.key !== selected.key || candidate.version !== selected.version))
      )
        return false;
      const rows = pane?.querySelectorAll('[data-ui-node="candidates"] tbody tr') ?? [];
      const row = [...rows].find(
        (r) =>
          r.cells[0]?.textContent === product &&
          r.cells[1]?.textContent === "usb" &&
          ["Select: " + candidate.key, "選取: " + candidate.key].includes(
            r.querySelector("button")?.getAttribute("aria-label"),
          ),
      );
      if (step === "select") {
        const evidence = { key: candidate.key, version: candidate.version, publication };
        return click(row?.querySelector("button")) && evidence;
      }
      if (row) window.__uhidDiscovery.rendered();
      return row?.textContent;
    }
    case "connected": {
      const text = pane?.querySelector('[data-ui-node="connection"]')?.textContent;
      return text?.includes(product + " · connected") && text;
    }
  }
}

// JSON-RPC ids are scoped to the peer and the utility process. During a
// deadline the outer command may still be pending; retain the inner reply.
export function matchDiscoveryWire(rows, status, product) {
  const binding = status.selected?.publication.binding ?? status.binding;
  const invocationId = status.reply?.value?.invocationId;
  const requests = rows.filter(
    (row) =>
      row.direction === "host-plugin" &&
      row.message.method === "command/invoke" &&
      row.message.params.command === "kobrixa.device-ev3.discover" &&
      row.message.params.context.binding.panelInstance === binding?.panelInstance &&
      (!invocationId || row.message.params.invocationId === invocationId),
  );
  assert.equal(requests.length, 1, "original Discover invocation");
  const command = requests[0];
  assert.deepEqual(command.message.params.context.binding, binding);
  const port = rows
    .slice(rows.indexOf(command) + 1)
    .filter(
      (row) =>
        row.utility === command.utility && row.owner?.processEpoch === command.owner.processEpoch,
    );
  const end = port.findIndex(
    (row) =>
      row.direction === "plugin-host" &&
      !row.message.method &&
      row.message.id === command.message.id,
  );
  const calls = end < 0 ? port : port.slice(0, end);
  const queries = calls.filter(
    (row) => row.direction === "plugin-host" && row.message.method === "devices/discover",
  );
  assert.equal(queries.length, 1, "single original broker discovery");
  const query = queries[0];
  const answer = calls
    .slice(calls.indexOf(query) + 1)
    .find(
      (row) =>
        row.direction === "host-plugin" &&
        !row.message.method &&
        row.message.id === query.message.id,
    );
  assert.ok(
    answer?.message.result?.ok,
    "successful original devices/discover reply: " + JSON.stringify(answer?.message),
  );
  const candidates = answer.message.result.value.candidates;
  const candidate = candidates.find(
    (c) =>
      c.name === product &&
      c.transport === "usb" &&
      (!status.selected || c.candidateId === status.selected.key),
  );
  assert.ok(
    candidate,
    "broker candidate matching published and rendered USB row: " + JSON.stringify(candidates),
  );
  assert.ok(end >= 0 && port[end].message.result?.ok, "original Discover command reply");
  assert.ok(invocationId, "renderer Discover reply");
  assert.ok(status.selected, status.missing ?? "published candidate and matching rendered row");
  return { invocationId, requestId: query.message.id, candidate, selected: status.selected };
}

// The accessible name identifies a key. The command sent by the installed
// renderer also carries the revision actually selected by its row handler.
export function matchSelectedRow(rows, selected) {
  const { binding, revision } = selected.publication;
  const commands = rows.filter(
    ({ direction, message }) =>
      direction === "host-plugin" &&
      message.method === "command/invoke" &&
      message.params.command === "kobrixa.device-ev3.candidate" &&
      message.params.context.binding?.panelInstance === binding.panelInstance,
  );
  assert.equal(commands.length, 1, "one original candidate selection");
  const { params } = commands[0].message;
  assert.deepEqual(params.context.binding, binding);
  assert.deepEqual(
    params.arguments,
    { key: selected.key, version: selected.version, dataset: revision },
    "rendered row must select the observed candidates revision",
  );
  return { invocationId: params.invocationId, ...selected };
}

export async function connectUhidPanel(client, traceFile, readDeviceWire, check = () => {}) {
  const name = "Kobrixa UHID spike";
  const step = (action) =>
    client.js(
      `(${devicePanelStep.toString()})(${JSON.stringify(action)}, ${JSON.stringify(name)})`,
    );
  const diagnostics = async () => {
    const status = await step("diagnostics");
    if (!status.armed) return status;
    try {
      return { ...status, discovery: matchDiscoveryWire(await readDeviceWire(), status, name) };
    } catch (error) {
      return { ...status, wireObservation: error.message };
    }
  };
  const wait = (action) =>
    until(
      () => {
        check();
        return step(action);
      },
      "EV3 panel " + action,
      30000,
      diagnostics,
    );
  const gates = JSON.parse(
    await readFile(path.join(path.dirname(traceFile), "gates.json"), "utf8"),
  );
  if (gates.G2.status !== "PASS") throw new Error("UHID provisioning incomplete");
  await access(gates.G2.observation.device, constants.R_OK | constants.W_OK);
  await client.js(
    `window.__uhidDiscovery=(${observeCandidatePublication.toString()})(window.kobrixa.plugins.ui,${JSON.stringify(name)});true`,
  );
  let stopCommands;
  try {
    stopCommands = await observeDiscoveryCommand(client);
    await wait("tools");
    await wait("device");
    let requestedOpen = false;
    await until(
      async () => {
        check();
        if (await step("discover")) return true;
        if (!requestedOpen) requestedOpen = await step("open");
        return false;
      },
      "open EV3 device panel and click Discover",
      30000,
      diagnostics,
    );
    const rendered = await wait("candidate");
    const status = await step("diagnostics");
    const discovery = {
      fixture: gates.G2.observation,
      preferences: status.preferences,
      ...matchDiscoveryWire(await readDeviceWire(), status, name),
    };
    console.log("Discovered row", rendered, discovery);
    const offset = (await stat(traceFile)).size;
    const selected = await wait("select");
    const connection = await wait("connected");
    discovery.selection = matchSelectedRow(await readDeviceWire(), selected);
    return { connection, offset, step, discovery };
  } finally {
    try {
      await stopCommands?.();
    } finally {
      await client.js("window.__uhidDiscovery.dispose(); delete window.__uhidDiscovery");
    }
  }
}
