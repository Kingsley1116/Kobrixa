import type { DeviceDrainGrant, ProfileWriterLock, Stage3RuntimePorts } from "@kobrixa/plugin-runtime";
import type { PersistenceHost } from "../../apps/desktop/src/main/plugins/persistence/host-port.js";
export declare function createFoundationFixture(): Promise<FoundationFixture>;
export type FoundationCase = "contention"|"retirement"|"registration-end"|"healthy-release"|
  "disconnect-retry"|"suspend-wake"|"renderer-loss"|"sealed-ttl"|"unknown-publication"|
  "all-optional-off"|"action-replay"|"import-restart"|"storage-ui-pressure"|"compatibility"|"installed";

export type CaseEvidence = {checks:Record<string,string|number|boolean|readonly string[]|readonly number[]>;
  events:Array<{kind:string;turn:number;time:number;grant?:DeviceDrainGrant|null;deadline?:number}>;
  samples:Record<string,number[]>};

export interface FoundationFixture {
  composition:{profile:ProfileWriterLock;journalProfile:ProfileWriterLock;
    persistenceProfile:ProfileWriterLock;reservationListenerCount:number;workerCount:number;
    host:PersistenceHost;stage3:Stage3RuntimePorts};
  environment:{commit:string;artifact:string;artifactSha256:string;os:string;architecture:string;
    cpu:string;ramBytes:number;filesystem:string;node:string;electron:string;
    memoryMethod:string;warmCold:string};
  runCase(id:FoundationCase): Promise<CaseEvidence>;
  close(): Promise<void>;
}

/* Frozen measurement manifest for the T7 implementation (no measurements claimed).
{
  "settingsKeys":128,"settingsResourceBytes":65536,"settingsValuesBytes":65536,"stringBytes":4096,
  "recordBytes":8388608,"recordsPerSource":256,"sourceBytes":536870912,"hostBytes":1073741824,
  "chunkBytes":262144,"chunkEncodedBytes":349528,"listEntries":64,"listResultBytes":262144,
  "sourceWriteSlots":2,"hostWriteSlots":16,"sourceExportSlots":1,"hostExportSlots":4,
  "temporarySourceBytes":33554432,"temporaryHostBytes":134217728,"metadataSourceBytes":4194304,"metadataHostBytes":67108864,
  "diskHeadroomBytes":16777216,"pendingRequests":32,"pendingHostBytes":8388608,"pendingSourceBytes":1048576,"ioJobs":4,
  "idleMs":30000,"totalMs":120000,"rpcMs":10000,"drainMs":10000,"cleanupMs":24000,"outerMs":25000,
  "workload":{"records":50,"recordBytes":8388608,"stagedRecords":2,"concurrentJobs":4,"samples":30},
  "measurement":["OS","architecture","CPU","RAM","filesystem","artifact","commit","Node","Electron","fixtureBytes","records","warmCold","samples","p50","p95","max","mainRSS","workerRSS","memoryMethod"],
  "thresholds":{"draftP95Ms":50,"pageP95Ms":100,"listP95Ms":200,"mainSyncMaxMs":16,"mainAdditionalRSS":33554432,"workerAdditionalRSS":67108864,"commitFlushMaxMs":10000,"extraStopDispatchP95Ms":50}
}
*/
