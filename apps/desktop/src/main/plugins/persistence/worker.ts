import type { ProfileWriterLock } from "@kobrixa/plugin-runtime";
import type { Handle } from "@kobrixa/plugin-protocol";
import type { StoreRoot, PersistenceFaultPoint } from "./filesystem.js";
import type { PersistenceBackend } from "./engine-port.js";
import type { LegacyImportDescriptor } from "./import-sources.js";
export declare function runPersistenceWorker(input:{mappers:ReadonlyMap<string,LegacyImportDescriptor>;sourceRoots?:ReadonlyMap<string,string>}):void;
export declare function startPersistenceWorker(input: {
  profile: ProfileWriterLock; root: StoreRoot; workerEntry: string;
  now: () => number;
  testControl?: (control: PersistenceFaultControl) => void;
}): Promise<{backend: PersistenceBackend; recovery: "ready" | "blocked"}>;

export interface PersistenceFaultControl {
  arm(point:PersistenceFaultPoint, action:"pause"|"fail"|"kill"): void;
  reached(point:PersistenceFaultPoint): Promise<void>;
  release(point:PersistenceFaultPoint): void;
  trace(): readonly {point:PersistenceFaultPoint;time:number;ticket:Handle|null}[];
  terminate(): Promise<void>;
}
