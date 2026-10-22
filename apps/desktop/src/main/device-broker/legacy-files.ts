import type { DeviceSession } from "@kobrixa/device";
import type { Principal } from "@kobrixa/plugin-runtime";
import type { Handle } from "@kobrixa/plugin-protocol";
import type { LegacyOperationPort } from "./broker-port.js";
export interface LegacyFileSession extends Pick<DeviceSession, "list" | "download" | "upload" | "uploadStream" | "createDirectory" | "rename" | "delete" | "run"> {
  confirm<T>(dialog: () => Promise<T>): Promise<T>;
  renewConfirmation(): void;
  remaining(): { idleRemainingMs: number; totalRemainingMs: number };
  cancel(): Promise<void>;
}
export declare class LegacyFiles {
  constructor(operations: LegacyOperationPort, principal: (operationClass: "file-read" | "file-write" | "deployment" | "program-launch") => Principal, now?: () => number);
  run<T>(sessionId: Handle, work: (session: LegacyFileSession, signal: AbortSignal) => Promise<T>, operationClass?: "file-read" | "file-write" | "deployment" | "program-launch"): Promise<T>;
}
