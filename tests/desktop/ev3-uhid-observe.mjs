import assert from "node:assert/strict";
import { until } from "./builtin-installed-client.mjs";

export const RECORDING_CRITERION = "installed-recording-bracketing-v1";

// Serialized into the primary. launchNode transfers port2 to this exact child,
// then synchronously starts port1 before returning its channel to the runtime.
export function observeLabFork(child, ownerText, rows) {
  const owner = JSON.parse(ownerText);
  const send = child.postMessage;
  const descriptor = Object.getOwnPropertyDescriptor(child, "postMessage");
  const cleanups = [];
  function restoreChild() {
    if (child.postMessage !== observedPost) return;
    if (descriptor) Object.defineProperty(child, "postMessage", descriptor);
    else delete child.postMessage;
  }
  function observedPost(...args) {
    if (args[0]?.type !== "kobrixa-plugin-port" || args[1]?.length !== 1)
      return Reflect.apply(send, this, args);
    const proto = Object.getPrototypeOf(args[1][0]);
    const result = Reflect.apply(send, this, args);
    restoreChild();
    const start = proto.start;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "start");
    const restore = () => {
      if (proto.start !== observedStart) return;
      if (descriptor) Object.defineProperty(proto, "start", descriptor);
      else delete proto.start;
    };
    function observedStart(...params) {
      restore();
      const capture = (direction, text, sendStartedAt) => {
        try {
          rows.push({
            pid: process.pid,
            utility: child.pid,
            owner,
            direction,
            ...(sendStartedAt === undefined ? {} : { sendStartedAt }),
            at: Number(process.hrtime.bigint()) / 1e6,
            wall: Date.now(),
            after: Number(process.hrtime.bigint()) / 1e6,
            message: JSON.parse(text),
          });
        } catch (error) {
          rows.push({ error: String(error) });
        }
      };
      const receive = (event) => capture("plugin-host", event.data);
      this.on("message", receive);
      const post = this.postMessage;
      const ownPost = Object.getOwnPropertyDescriptor(this, "postMessage");
      const observed = function (text, ...rest) {
        const sendStartedAt = Number(process.hrtime.bigint()) / 1e6;
        const result = Reflect.apply(post, this, [text, ...rest]);
        capture("host-plugin", text, sendStartedAt);
        return result;
      };
      this.postMessage = observed;
      const close = () => {
        this.off("close", close);
        this.off("message", receive);
        if (this.postMessage === observed) {
          if (ownPost) Object.defineProperty(this, "postMessage", ownPost);
          else delete this.postMessage;
        }
      };
      cleanups.push(close);
      this.once("close", close);
      return Reflect.apply(start, this, params);
    }
    cleanups.push(restore);
    proto.start = observedStart;
    queueMicrotask(restore);
    return result;
  }
  child.postMessage = observedPost;
  return () => {
    restoreChild();
    for (const cleanup of cleanups) cleanup();
  };
}

// Locate the statement immediately following the host-internal awaited release.
// A changed build shape cannot silently move the probe into another operation.
export function releaseSite(source) {
  const pattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*await\s+([\w$]+)\.request\(\s*([\w$]+),\s*["'`]devices\/recording\/release["'`],\s*\{\s*reservationId:\s*([\w$]+)\.data\s*\},\s*[\w$]+,?\s*\);\s*(?:return\s+|if\s*\(!?)/g;
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, "original host broker release observation site");
  const [match] = matches;
  const end = match.index + match[0].length;
  assert.ok(source.slice(end).startsWith(match[2] + ".current()"), "original release continuation");
  const lines = source.slice(0, end).split("\n");
  return {
    lineNumber: lines.length - 1,
    columnNumber: lines.at(-1).length,
    condition:
      "(__installedProbe.releases.push({at:Number(process.hrtime.bigint())/1e6,primary:process.pid,owner:" +
      match[3] +
      ".owner,reservationId:" +
      match[4] +
      ".data,result:" +
      match[1] +
      "}),false)",
  };
}

export async function observeRelease(main, archive, expectedSource) {
  const scripts = [];
  const off = main.on("Debugger.scriptParsed", (s) => scripts.push(s));
  let installed;
  const cleanup = async () => {
    try {
      if (installed) await main.send("Debugger.removeBreakpoint", { breakpointId: installed });
    } finally {
      await main.send("Debugger.disable");
    }
  };
  try {
    await main.send("Debugger.enable");
    const script = scripts.find((s) => s.url.endsWith(archive + "/.vite/build/main.cjs"));
    assert.ok(script, "copied primary script in inspector");
    const { scriptSource } = await main.send("Debugger.getScriptSource", {
      scriptId: script.scriptId,
    });
    assert.equal(scriptSource === expectedSource, true, "executing copied primary source");
    const { condition, ...site } = releaseSite(scriptSource);
    const { actualLocation, breakpointId } = await main.send("Debugger.setBreakpoint", {
      location: { scriptId: script.scriptId, ...site },
      condition,
    });
    installed = breakpointId;
    assert.equal(actualLocation.scriptId, script.scriptId);
    assert.equal(actualLocation.lineNumber, site.lineNumber);
    assert.ok(
      actualLocation.columnNumber >= site.columnNumber &&
        actualLocation.columnNumber <= site.columnNumber + 12,
      "release observation moved beyond original callback",
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    off();
  }
}

// Missing recording observations must leave the ordinary installed checks and
// graceful cleanup runnable. Only the independent validator can clear unrun.
export async function observeRecordingItem(recording, label, observe) {
  try {
    return await observe();
  } catch (error) {
    recording.missing.push(label + " — " + error.message);
    return undefined;
  }
}

export const monotonic = () => Number(process.hrtime.bigint()) / 1e6;

export async function waitRecordingFrames(main, after, count) {
  return until(
    () =>
      main.js(`(() => {
    const rows=__installedProbe.wire;
    const reads=rows.filter(r=>r.direction==='plugin-host' && r.message.method==='devices/recording/read');
    const frames=reads.flatMap(q=>rows.find(r=>r.direction==='host-plugin' && r.message.id===q.message.id && !r.message.method)?.message.result?.value?.frames ?? []);
    return new Set(frames.filter(f=>f.sequence>${after} && f.status==='ok' && !f.gap).map(f=>f.sequence)).size>=${count} && frames.at(-1).sequence;
  })()`),
    "fresh Lab recording frames",
  );
}

// Run inside the packaged renderer. Return coordinates for one Chromium input.
function labTarget(action, name) {
  const pane = document.querySelector(".plugin-tools-pane [role=tabpanel]");
  let el;
  if (action === "tools") el = document.querySelector(".plugin-tools-toggle");
  else if (action === "tab")
    el = [...document.querySelectorAll(".plugin-tools-pane [role=tab]")].find((t) =>
      ["Sensor Lab", "感測器工具"].includes(t.title),
    );
  else if (action === "recording-name")
    el = pane?.querySelector('[data-ui-node="recording-name"] input');
  else if (action === "available" || action === "history") {
    const row = [
      ...(pane?.querySelectorAll('[data-ui-node="' + action + '"] tbody tr') ?? []),
    ].find((r) =>
      action === "available"
        ? r.cells[0]?.textContent.startsWith("Spike sensor ·")
        : r.cells[0]?.textContent === name,
    );
    el =
      action === "available"
        ? row?.querySelector("button")
        : [...(row?.querySelectorAll("button") ?? [])].find((b) =>
            ["View", "檢視"].includes(b.textContent.trim()),
          );
  } else el = pane?.querySelector('[data-ui-node="' + action + '"] button');
  if (!el || el.disabled || !el.getClientRects().length) return false;
  el.scrollIntoView({ block: "center" });
  const rect = el.getBoundingClientRect(),
    x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  return el.contains(document.elementFromPoint(x, y)) && { x, y };
}
export async function labClick(renderer, action, name = "") {
  const pos = await until(
    () => renderer.js(`(${labTarget})(${JSON.stringify(action)},${JSON.stringify(name)})`),
    "Lab control " + action,
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await renderer.send("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      ...pos,
    });
}
export async function openLab(renderer) {
  if (
    !(await renderer.js(
      `document.querySelector(".plugin-tools-toggle")?.getAttribute("aria-pressed")==="true"`,
    ))
  )
    await labClick(renderer, "tools");
  await labClick(renderer, "tab");
  await until(
    () =>
      renderer.js(
        `["Sensor Lab","感測器工具"].includes(document.querySelector('.plugin-tools-pane [aria-selected=true]')?.title)`,
      ),
    "selected Lab tab",
  );
  // Selecting this tab calls session.open().
  await until(
    () =>
      renderer.js(
        `Boolean(document.querySelector('.plugin-tools-pane [role=tabpanel] [data-ui-node="recording-name"]'))`,
      ),
    "opened Lab panel",
  );
}
// Wait for the one user action already dispatched. Never click again to turn
// a failed command into a success.
export async function waitLabCommand(main, name) {
  return until(async () => {
    const observed = await main.js(`(() => {
      const rows=__installedProbe.wire;
      const q=rows.find(r=>r.direction==='host-plugin' && r.message.method==='command/invoke' && r.message.params.command===${JSON.stringify("kobrixa.sensor-lab." + name)});
      if(!q)return null;
      const reply=rows.find(r=>r.direction==='plugin-host' && r.message.id===q.message.id && !r.message.method);
      return reply && {binding:q.message.params.context.binding,reply:reply.message};
    })()`);
    if (!observed) return false;
    assert.equal(observed.reply.result?.ok, true, JSON.stringify(observed.reply));
    assert.deepEqual(observed.reply.result.value.fieldErrors, []);
    return observed.binding;
  }, "completed Lab command " + name);
}

export async function startLab(client, name) {
  await openLab(client.renderer);
  await labClick(client.renderer, "select-current");
  await waitLabCommand(client.main, "select-current");
  await labClick(client.renderer, "available");
  const binding = await waitLabCommand(client.main, "select-channel");
  await labClick(client.renderer, "recording-name");
  await client.renderer.send("Input.insertText", { text: name });
  await until(
    () =>
      client.renderer.js(
        `window.kobrixa.plugins.ui.snapshot({binding:${JSON.stringify(binding)}}).then(r=>r.ok && r.value.form["recording-name"]===${JSON.stringify(name)} && r.value.data["can-start"]===true)`,
      ),
    "canonical Lab recording name and ready selection",
  );
  await labClick(client.renderer, "start");
  await waitLabCommand(client.main, "start");
  await waitRecordingFrames(client.main, -1, 3);
  return binding;
}
