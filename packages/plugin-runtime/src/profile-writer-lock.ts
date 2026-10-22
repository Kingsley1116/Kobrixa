import type { Handle } from "@kobrixa/plugin-protocol";
export interface ProfileWriterLock {
  readonly hostEpoch: Handle;
  assertHeld(): void; // 同步；非 primary／host 已退出寫入 lifetime 就拒絕。
}
