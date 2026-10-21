import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { quitOnSignals, SessionMarkerFile, watchRendererHealth } from "./session.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-session-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));
const marker = () => new SessionMarkerFile(root, () => new Date("2026-10-15T00:00:00.000Z"));
const onDisk = async () =>
  JSON.parse(await readFile(path.join(root, "plugins/session.json"), "utf8"));

it("starts a marker and removes it on a clean exit", async () => {
  const session = marker();
  expect(session.begin()).toBeUndefined();
  expect(await onDisk()).toEqual({
    startedAt: "2026-10-15T00:00:00.000Z",
    thirdPartyRunning: false,
    thirdPartyStaticContributions: false,
    rendererUnresponsive: false,
  });
  session.update({ thirdPartyRunning: true });
  expect((await onDisk()).thirdPartyRunning).toBe(true);
  session.finish();
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(marker().begin()).toBeUndefined();
});

it("reports a crash while a third-party process ran", () => {
  const session = marker();
  session.begin();
  session.update({ thirdPartyRunning: true });
  expect(marker().begin()).toBe("unclean-exit");
});

it("ignores a crash while no third-party process ran", () => {
  const session = marker();
  session.begin();
  session.update({ thirdPartyRunning: true });
  session.update({ thirdPartyRunning: false });
  expect(marker().begin()).toBeUndefined();
});

it("keeps the marker after a hang even when the session ends cleanly", async () => {
  const session = marker();
  session.begin();
  session.update({ rendererUnresponsive: true });
  session.update({ thirdPartyRunning: true });
  session.finish();
  expect(await onDisk()).toMatchObject({ rendererUnresponsive: true, thirdPartyRunning: false });
  const next = marker();
  expect(next.begin()).toBe("renderer-unresponsive");
  // The new session starts clean, so its own clean exit clears the marker again.
  next.finish();
  expect(marker().begin()).toBeUndefined();
});

it("ignores an unreadable marker and stops writing after finish", async () => {
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await writeFile(path.join(root, "plugins/session.json"), "{not json");
  const session = marker();
  expect(session.begin()).toBeUndefined();
  session.finish();
  session.update({ thirdPartyRunning: true });
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("quits through Electron on SIGINT and SIGTERM", () => {
  const signals = new EventEmitter();
  const quit = vi.fn();
  quitOnSignals(signals, quit);
  signals.emit("SIGINT");
  signals.emit("SIGTERM");
  expect(quit).toHaveBeenCalledTimes(2);
});

it("treats an unresponsive window or a crashed renderer as a hang, but not a clean exit", () => {
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const onHang = vi.fn();
  watchRendererHealth(window, onHang);
  window.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
  expect(onHang).not.toHaveBeenCalled();
  window.emit("unresponsive");
  window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  expect(onHang).toHaveBeenCalledTimes(2);
});

it("persists static risk synchronously and keeps it when no process is running", async () => {
  const session = marker();
  session.begin();
  session.markThirdPartyStaticContributions();
  expect(await onDisk()).toMatchObject({
    thirdPartyRunning: false,
    thirdPartyStaticContributions: true,
  });
  session.update({ thirdPartyRunning: true });
  session.update({ thirdPartyRunning: false });
  expect((await onDisk()).thirdPartyStaticContributions).toBe(true);
  const restarted = marker();
  expect(restarted.begin()).toBe("unclean-exit");
  expect(restarted.previousThirdPartyStaticContributions).toBe(true);
  expect((await onDisk()).thirdPartyStaticContributions).toBe(false);
});

it("reads old markers without the static field", async () => {
  await mkdir(path.join(root, "plugins"), { recursive: true });
  await writeFile(
    path.join(root, "plugins/session.json"),
    JSON.stringify({
      startedAt: "2026-10-15T00:00:00.000Z",
      thirdPartyRunning: false,
      rendererUnresponsive: false,
    }),
  );
  const session = marker();
  expect(session.begin()).toBeUndefined();
  expect(session.previousThirdPartyStaticContributions).toBe(false);
  expect((await onDisk()).thirdPartyStaticContributions).toBe(false);
});

it("keeps static risk and the higher-priority hang reason through finish", async () => {
  const session = marker();
  session.begin();
  session.markThirdPartyStaticContributions();
  session.update({ rendererUnresponsive: true });
  session.finish();
  expect(await onDisk()).toMatchObject({
    thirdPartyRunning: false,
    thirdPartyStaticContributions: true,
    rendererUnresponsive: true,
  });
  expect(marker().begin()).toBe("renderer-unresponsive");
});

it("removes static risk on a clean exit and refuses writes outside a live session", async () => {
  const session = marker();
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  session.begin();
  session.markThirdPartyStaticContributions();
  session.finish();
  await expect(readFile(session.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  expect(marker().begin()).toBeUndefined();
});

it("throws on a failed checked write and retries instead of caching an unwritten true", async () => {
  const session = marker();
  session.begin();
  // A directory at the destination makes the atomic rename fail on every platform.
  await rm(session.file);
  await mkdir(session.file);
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  expect(() => session.markThirdPartyStaticContributions()).toThrow("PLUGIN_E_STATE_SAVE");
  await rm(session.file, { recursive: true });
  session.markThirdPartyStaticContributions();
  expect((await onDisk()).thirdPartyStaticContributions).toBe(true);
  expect(marker().begin()).toBe("unclean-exit");
});
import { filePluginStateStore } from "./state-store.js";
it.each([false, true])("D150 crash recovery risk=%s never re-enables a persisted optional builtin", async risk => {
  const store = filePluginStateStore(root);
  await store.load();
  await store.save({ disabled: new Set(["builtin:kobrixa.device-ev3"]), legacyDisabledIds: new Set() });
  const crashed = marker(); crashed.begin(); crashed.update({ thirdPartyRunning: risk });
  expect(marker().begin()).toBe(risk ? "unclean-exit" : undefined);
  expect((await filePluginStateStore(root).load()).disabled).toEqual(new Set(["builtin:kobrixa.device-ev3"]));
});
