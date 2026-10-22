import { randomUUID } from "node:crypto";
import type { ProfileWriterLock } from "@kobrixa/plugin-runtime";

export interface PrimaryHost {
  requestSingleInstanceLock(): boolean;
  hasSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  quit(): void;
  on(name: "second-instance" | "quit", listener: () => void): unknown;
}
export function startPrimary(
  app: PrimaryHost,
  start: (profile: ProfileWriterLock) => Promise<void>,
  focus: () => boolean,
): { profile: ProfileWriterLock; ready: Promise<void>; windowReady(): void } | null {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return null;
  }
  let held = true;
  let pendingFocus = false;
  const profile: ProfileWriterLock = Object.freeze({
    hostEpoch: randomUUID(),
    assertHeld() {
      if (!held || !app.hasSingleInstanceLock())
        throw new Error("Primary profile writer lock is not held.");
    },
  });
  app.on("second-instance", () => {
    pendingFocus = !focus();
  });
  app.on("quit", () => {
    held = false;
  });
  const ready = app.whenReady().then(() => {
    profile.assertHeld();
    return start(profile);
  });
  return {
    profile,
    ready,
    windowReady() {
      if (pendingFocus && focus()) pendingFocus = false;
    },
  };
}
