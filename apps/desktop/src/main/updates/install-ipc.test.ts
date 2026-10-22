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

it("does not call quitAndInstall when the shared device/journal/storage guard rejects", async () => {
  const renderer = { id: 1, mainFrame: {} };
  const install = vi.fn();
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { install } as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    async () => {
      throw new Error("save outcome unknown");
    },
  );
  await expect(
    handlers.get("updates:install")!({ sender: renderer, senderFrame: renderer.mainFrame }),
  ).rejects.toThrow("save outcome unknown");
  expect(install).not.toHaveBeenCalled();
});
it("gates install on the reversible preparation receipt", async () => {
  const renderer = { id: 1, mainFrame: {} };
  const prepareInstall = vi.fn(),
    install = vi.fn(),
    cancelInstall = vi.fn(),
    cleanup = vi.fn(async () => {});
  let done!: () => void;
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { prepareInstall, install, cancelInstall } as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    cleanup,
    undefined,
    undefined,
    undefined,
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const preparing = handlers.get("updates:prepare")!(event);
  await Promise.resolve();
  expect(prepareInstall).toHaveBeenCalledOnce();
  expect(cleanup).not.toHaveBeenCalled();
  const installing = handlers.get("updates:install")!(event);
  await Promise.resolve();
  expect(install).not.toHaveBeenCalled();
  done();
  await preparing;
  await installing;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
});
it("waits for preparation before reopening admission on cancel, without closing the broker", async () => {
  const renderer = { id: 1, mainFrame: {} };
  const prepareInstall = vi.fn(),
    install = vi.fn(),
    cancelInstall = vi.fn(),
    cleanup = vi.fn(async () => {});
  let done!: () => void;
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { prepareInstall, install, cancelInstall } as never,
    new UpdateOperationGate(() => undefined),
    undefined,
    undefined,
    undefined,
    [],
    cleanup,
    undefined,
    undefined,
    undefined,
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  const preparing = handlers.get("updates:prepare")!(event);
  await Promise.resolve();
  const cancelling = handlers.get("updates:cancel")!(event);
  await Promise.resolve();
  expect(cancelInstall).not.toHaveBeenCalled();
  done();
  await preparing;
  await cancelling;
  expect(cancelInstall).toHaveBeenCalledOnce();
  expect(cleanup).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});
