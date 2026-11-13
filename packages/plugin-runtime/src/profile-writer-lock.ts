// packages/plugin-runtime/src/profile-writer-lock.ts
import type { Handle } from "@kobrixa/plugin-protocol";
export interface ProfileWriterLock {
  readonly hostEpoch: Handle;
  assertHeld(): void;
}
