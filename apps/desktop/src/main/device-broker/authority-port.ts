import type { Handle } from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";

// host-only；不得從 plugin JSON 建立。
export type AuthorityContextRecord = {
  ref: Handle;
  epoch: Handle;
  workbenchInstance: Handle;
  state: "local" | "joining" | "room" | "unsynced" | "invalid";
  roomBinding: Handle | null;
  connected: boolean;
  synced: boolean;
  role: "host" | "editor" | "viewer" | null;
  isHolder: boolean;
};
export interface AuthorityPort {
  current(principal: Principal, contextRef: Handle): AuthorityContextRecord | null;
  assertContinuation(principal: Principal, contextRef: Handle): void;
  subscribe(listener: (ref: Handle, epoch: Handle) => void): () => void;
}
