import { expect, it, vi } from "vitest";
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));
import { registerIpc } from "../ipc.js";
import { UpdateOperationGate } from "./service.js";

it("stops plugins before quitAndInstall starts", async () => {
  const renderer = { id: 1, mainFrame: {} };
  const order: string[] = [];
  let finish!: () => void;
  const updates = { install: vi.fn(() => order.push("install")) };
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    updates as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    () => new Promise<void>((resolve) => (finish = () => (order.push("plugins"), resolve()))),
  );
  const installing = handlers.get("updates:install")!({
    sender: renderer,
    senderFrame: renderer.mainFrame,
  });
  await Promise.resolve();
  expect(updates.install).not.toHaveBeenCalled();
  finish();
  await installing;
  expect(order).toEqual(["plugins", "install"]);
});

it("never installs after a failed combined stop/save/journal guard", async () => {
  handlers.clear();
  const renderer = { id: 1, mainFrame: {} };
  const updates = { install: vi.fn() };
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    updates as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    async () => {
      throw new Error("stop/save/journal unconfirmed");
    },
  );
  await expect(
    handlers.get("updates:install")!({ sender: renderer, senderFrame: renderer.mainFrame }),
  ).rejects.toThrow("unconfirmed");
  expect(updates.install).not.toHaveBeenCalled();
});
