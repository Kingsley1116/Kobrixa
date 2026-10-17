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
