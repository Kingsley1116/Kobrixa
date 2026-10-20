import type { Handle, Sha256, Version, Values, RecordWrite } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
export type LegacyPreferencesSnapshot = {
  nonce: Handle;
  scope: CoreWindowScope;
  entries: Array<{ key: string; raw: string | null }>;
};
export type LegacyImportInput = {
  sourceKind: "sensor-lab" | "device-settings" | "renderer-preferences";
  bytes: Uint8Array;
  sha256: Sha256;
};
export type LegacyImportItem =
  | { kind: "settings"; schemaVersion: Version; values: Values }
  | {
      kind: "record";
      metadata: Omit<RecordWrite, "target" | "checkpoint" | "drainToken">;
      bytes: Uint8Array;
    };
export interface LegacyImportDescriptor {
  id: string;
  mappingVersion: Version;
  targetSourceKey: string;
  sourceKind: LegacyImportInput["sourceKind"];
  sourceFormatVersions: readonly Version[];
  targetSettingsSchemaVersion?: Version;
  targetRecordSchemaVersions: readonly Version[];
  rendererKeyAllowlist?: readonly string[];
  validate(input: LegacyImportInput): boolean;
  map(input: LegacyImportInput): LegacyImportItem;
}
export interface LegacyImportCoordinator {
  run(
    descriptor: LegacyImportDescriptor,
    signal: AbortSignal,
  ): Promise<{
    state: "pending" | "planned" | "copying" | "complete" | "complete-empty" | "blocked";
    completedItems: number;
    totalItems: number;
  }>;
  acceptPreferences(snapshot: LegacyPreferencesSnapshot): Promise<void>;
}

import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend, PublicationTicket, LegacyPreferencesEvidenceRef } from "./engine-port.js";
export type LegacySourceItem = Readonly<{key:string; format:Version; byteLength:number; sha256:Sha256}>;

export type LegacyMappedItem = Readonly<{mapped:Handle;sourceSha256:Sha256;
  mappedSha256:Sha256;byteLength:number} & (
  {kind:"settings";schemaVersion:Version} |
  {kind:"record";metadata:Omit<RecordWrite,"target"|"checkpoint"|"drainToken">}
)>;

export interface LegacySourceResolver {
  resolvePreferences(input:{descriptorId:string;owner:PersistenceOwner;
    evidence:LegacyPreferencesEvidenceRef}):Promise<void>;
  register(input:{descriptorId:string;mapperId:string;sourceKind:LegacyImportInput["sourceKind"]}): Promise<void>;
  map(descriptorId:string, key:string): Promise<LegacyMappedItem>;
  appendMapped(input:{mapped:Handle;ticket:PublicationTicket;offset:number;
    maxBytes:number}): Promise<{nextOffset:number;done:boolean}>;
  releaseMapped(mapped:Handle): Promise<void>;
  inventory(descriptorId:string): Promise<{state:"present"|"absent"|"blocked";
    entries:readonly LegacySourceItem[]}>;
  read(descriptorId:string, key:string, offset:number, maxBytes:number): Promise<Uint8Array>;
}

export type LegacyPreferenceChallenge = Readonly<{nonce:Handle; scope:CoreWindowScope;
  descriptorId:string; keys:readonly string[]}>;

export interface LegacyWriterBarrier {
  enter(sourceKey:string, descriptorId:string): Promise<Handle>;
  restore(): Promise<readonly {sourceKey:string;descriptorId:string;barrier:Handle}[]>;
  complete(barrier:Handle): Promise<void>;
}

export interface LegacyImportHostPort extends LegacyImportCoordinator {
  issuePreferences(input:{descriptorId:string;scope:CoreWindowScope}): Promise<LegacyPreferenceChallenge>;
  retirePreferences(scope:CoreWindowScope): void;
  acceptPreferencesEvidence(snapshot:LegacyPreferencesSnapshot): Promise<{
    state:"accepted"|"pending"|"reconciled";
  }>;
}

export interface LegacyWriterPort {
  readonly sourceKey:string;
  freezeAdmission(): void;
  settled(): Promise<void>;
}

export declare function createLegacyWriterBarrier(input:{backend:PersistenceBackend;
  descriptors:readonly Pick<LegacyImportDescriptor,"id"|"targetSourceKey">[];
  writers:readonly LegacyWriterPort[];importOwner:(sourceKey:string)=>PersistenceOwner;
}): LegacyWriterBarrier;
