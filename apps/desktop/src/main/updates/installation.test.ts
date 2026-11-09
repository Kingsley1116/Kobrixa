import { expect, it, vi } from "vitest";
import { UpdateInstallation } from "./installation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const prepare = deferred(),
    resume = deferred();
  const service = {
    preparing: false,
    prepareInstall: vi.fn(() => {
      service.preparing = true;
    }),
    cancelInstall: vi.fn(() => {
      service.preparing = false;
    }),
    install: vi.fn(() => {
      service.preparing = false;
    }),
  };
  const cleanup = vi.fn(async () => {});
  const recover = vi.fn(() => resume.promise);
  const flow = new UpdateInstallation(service, () => prepare.promise, cleanup, recover);
  return { flow, service, prepare, resume, cleanup, recover };
}
it("native cancellation invalidates the receipt immediately but waits for retirement before readmission", async () => {
  const f = fixture();
  const preparing = f.flow.prepare();
  await Promise.resolve();
  const rejected = expect(preparing).rejects.toThrow("cancelled");
  const cancelling = f.flow.cancel();
  await expect(f.flow.prepare()).rejects.toThrow("busy");
  await expect(f.flow.install()).rejects.toThrow("prepared");
  expect(f.service.cancelInstall).not.toHaveBeenCalled();
  expect(f.recover).not.toHaveBeenCalled();
  f.prepare.resolve();
  await rejected;
  await vi.waitFor(() => expect(f.recover).toHaveBeenCalledOnce());
  await expect(f.flow.prepare()).rejects.toThrow("busy");
  expect(f.cleanup).not.toHaveBeenCalled();
  f.resume.resolve();
  await cancelling;
  await f.flow.prepare();
  expect(f.service.prepareInstall).toHaveBeenCalledTimes(2);
});
it("never enters irreversible cleanup without an active successful preparation", async () => {
  const f = fixture();
  await expect(f.flow.install()).rejects.toThrow("prepared");
  const p = f.flow.prepare();
  f.prepare.resolve();
  await p;
  f.service.preparing = false;
  await expect(f.flow.install()).rejects.toThrow("prepared");
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(f.service.install).not.toHaveBeenCalled();
});
it("install joins its preparation, and native loss cannot resume services during cleanup", async () => {
  const f = fixture(),
    cleanup = deferred();
  f.cleanup.mockImplementation(() => cleanup.promise);
  const p = f.flow.prepare();
  const installing = f.flow.install();
  expect(f.cleanup).not.toHaveBeenCalled();
  f.prepare.resolve();
  await p;
  await vi.waitFor(() => expect(f.cleanup).toHaveBeenCalledOnce());
  await f.flow.cancel();
  expect(f.recover).not.toHaveBeenCalled();
  expect(f.service.cancelInstall).not.toHaveBeenCalled();
  cleanup.resolve();
  await installing;
  expect(f.service.install).toHaveBeenCalledOnce();
  await expect(f.flow.install()).rejects.toThrow();
  expect(f.cleanup).toHaveBeenCalledOnce();
});
