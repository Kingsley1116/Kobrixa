import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { FoundationCounters } from "@kobrixa/plugin-runtime";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const wall = () => performance.timeOrigin + performance.now();

// Only the test transport is delayed. The trusted IPC handler, state registry,
// production preload, store and React components are unchanged.
export function snapshotDelay() {
  let milliseconds = 0;
  const pending = new Map<string, { count: number; bytes: number }>();
  const observations: Array<{
    at: number;
    id: string;
    count: number;
    bytes: number;
    revision: number;
    disposition: string;
  }> = [];
  return {
    begin() {
      milliseconds = 800;
    },
    end() {
      milliseconds = 0;
    },
    observations,
    async deliver(value: unknown): Promise<unknown> {
      const result = value as {
        ok: boolean;
        value?: { binding: { panelInstance: string }; revision: number };
      };
      if (!milliseconds || !result.ok || !result.value) return value;
      const delay = milliseconds;
      const id = result.value.binding.panelInstance;
      const bytes = Buffer.byteLength(JSON.stringify(result));
      const current = pending.get(id) ?? { count: 0, bytes: 0 };
      current.count++;
      current.bytes += bytes;
      pending.set(id, current);
      observations.push({
        at: wall(),
        id,
        ...current,
        revision: result.value.revision,
        disposition: "held",
      });
      await pause(delay);
      current.count--;
      current.bytes -= bytes;
      observations.push({
        at: wall(),
        id,
        ...current,
        revision: result.value.revision,
        disposition: "released",
      });
      if (!current.count) pending.delete(id);
      return value;
    },
    pending: () => [...pending.entries()].map(([id, value]) => ({ id, ...value })),
  };
}
export type SnapshotDelay = ReturnType<typeof snapshotDelay>;

export async function measureSlowRenderer(window: BrowserWindow, delay: SnapshotDelay) {
  const js = <T = unknown>(source: string): Promise<T> =>
    window.webContents.executeJavaScript(source);
  const point = await js<{ x: number; y: number }>("window.uiLoad.bounds('number')");
  window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  // This shell has no application Edit menu, so use native caret/backspace
  // events instead of assuming the platform Select All accelerator exists.
  for (const keyCode of [
    ...Array<string>(8).fill("Right"),
    ...Array<string>(8).fill("BACKSPACE"),
  ]) {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }
  window.webContents.sendInputEvent({ type: "char", keyCode: "-" });
  await pause(100);
  const initial = await js<{
    raw: string;
    focused: boolean;
    panelInstance: string;
    revision: number;
    active: boolean;
  }>("window.uiLoad.slowState()");
  assert.equal(initial.raw, "-");
  assert.equal(initial.focused, true);
  delay.begin();
  const start = wall();
  const samples: Array<{
    at: number;
    state: typeof initial;
    counters: Array<{ counters: FoundationCounters }>;
  }> = [];
  do {
    samples.push({
      at: wall(),
      state: await js("window.uiLoad.slowState()"),
      counters: await js("window.uiLoad.sample()"),
    });
    await pause(250);
  } while (wall() - start < 30000);
  const durationMs = wall() - start;
  assert.ok(samples.every((row) => row.state.raw === "-" && row.state.focused && row.state.active));
  assert.ok(
    samples.every((row) =>
      row.counters.every(
        (value) => value.counters.queuedEvents <= 4 && value.counters.queuedBytes <= 65536,
      ),
    ),
  );
  assert.ok(delay.observations.some((row) => row.disposition === "held"));
  assert.ok(delay.observations.every((row) => row.count <= 1 && row.bytes <= 65536));
  const revisions = samples.map((row) => row.state.revision);
  assert.ok(
    revisions.some((revision, i) => i > 0 && revision - revisions[i - 1]! > 1),
    "real snapshot revision gaps recover",
  );
  // Close the actual selected panel while its genuine snapshot reply is held.
  const deadline = performance.now() + 3000;
  while (!delay.pending().some((row) => row.id === initial.panelInstance)) {
    assert.ok(performance.now() < deadline, "selected snapshot held");
    await pause(20);
  }
  await js("window.uiLoad.closeSelected()");
  delay.end();
  await pause(1000);
  const afterClose = await js<boolean>(
    `window.uiLoad.hasInstance(${JSON.stringify(initial.panelInstance)})`,
  );
  assert.equal(afterClose, false, "late snapshot must not revive a closed panel");
  const reopened = await js<{ panelInstance: string; revision: number }>(
    "window.uiLoad.reopenFirst()",
  );
  assert.notEqual(reopened.panelInstance, initial.panelInstance);
  await pause(500);
  const after = await js<typeof initial>("window.uiLoad.slowState()");
  assert.ok(
    after.active && after.revision > reopened.revision,
    "fresh instance receives visible updates",
  );
  assert.deepEqual(delay.pending(), []);
  return {
    durationMs,
    start,
    initial,
    samples,
    snapshotDeliveries: delay.observations,
    afterClose,
    reopened,
    after,
    delayMs: 800,
    scope: "actual renderer snapshot backpressure; common SDK event overflow is a separate gate",
  };
}
