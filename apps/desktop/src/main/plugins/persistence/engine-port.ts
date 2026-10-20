import type { Handle, SettingsSnapshot, SettingsRevision, RecordRevision, RecordId, Receipt, Version, Sha256, RecordMeta } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
export type PublicationTicket = Readonly<{
  id: Handle;
  owner: PersistenceOwner;
  deadlineMonotonicMs: number;
  metadata:
    | { kind: "settings"; schemaVersion: Version; validationDigest: Sha256 }
    | { kind: "record"; record: RecordMeta; deleted: boolean }
    | { kind: "recovery" | "import"; key: string };
  target:
    | { kind: "settings"; expectedRevision: SettingsRevision | null }
    | { kind: "record"; id: RecordId; expectedRevision: RecordRevision | null }
    | { kind: "recovery" | "import"; key: string };
}>;
export interface PersistenceEnginePort {
  reserve(ticket: PublicationTicket, byteLength: number): Promise<void>;
  append(ticket: PublicationTicket, offset: number, bytes: Uint8Array): Promise<number>;
  seal(ticket: PublicationTicket, byteLength: number, sha256: Sha256): Promise<void>;
  publish(ticket: PublicationTicket): Promise<{
    disposition: "not-committed" | "committed" | "unknown";
    receipt?: Receipt<SettingsRevision | RecordRevision>;
  }>;
  fence(owner: PersistenceOwner, deadlineMonotonicMs: number): readonly Handle[];
  fenceTarget(
    owner: PersistenceOwner,
    id: RecordId,
    deadlineMonotonicMs: number,
  ): readonly Handle[];
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["publish"]>;
  abort(ticket: PublicationTicket): Promise<"aborted" | "committed" | "unknown">;
}

// B2-T2 engine-port.ts; immutable snapshots and byte pins do not hold device locks.
export interface PersistenceReadPort {
  settings(owner: PersistenceOwner): Promise<SettingsSnapshot | null>;
  stat(owner: PersistenceOwner, id: RecordId): Promise<RecordMeta>;
  list(
    owner: PersistenceOwner,
    input: { kind?: string; limit: number; cursor?: Handle },
  ): Promise<{ entries: RecordMeta[]; nextCursor?: Handle }>;
  open(owner: PersistenceOwner, id: RecordId, revision: RecordRevision): Promise<Handle>;
  read(owner: PersistenceOwner, pin: Handle, offset: number, maxBytes: number): Promise<Uint8Array>;
  close(owner: PersistenceOwner, pin: Handle): Promise<void>;
}

import type { Durability, ResourceOwner, Counter, Timestamp, StorageRequestMap } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, DrainReport } from "@kobrixa/plugin-runtime";
import type { ExportDestination } from "./actions.js";
import type { LegacySourceResolver } from "./import-sources.js";
export type { PersistenceOwner } from "@kobrixa/plugin-runtime";
export interface PersistenceBackend {
  readonly engine: PersistenceEnginePort;
  readonly reads: PersistenceReadPort;
  readonly evidence: PersistenceEvidencePort; // AM-26
  readonly imports: DurableImportPort; // AM-24
  readonly output: PersistenceOutputPort; // AM-25
  readonly destinations: ExportDestinationRegistry; // AM-25
  readonly sources: LegacySourceResolver; // AM-29
  dispose(): Promise<void>;
}

export type ImportTag = Readonly<{importId:string; itemKey:string; sourceSha256:Sha256}>;

export type ImportPlannedItem = Readonly<{
  key:string; sourceFormat:Version; sourceSha256:Sha256; mappedSha256:Sha256; byteLength:number;
  ticket:PublicationTicket; tag:ImportTag;
}>;

export type LegacyPreferencesEvidenceRef = Readonly<{nonce:Handle; digest:Sha256}>;

export type ImportPlan = Readonly<{formatVersion:1; id:string; descriptorId:string; mappingVersion:Version;
  targetSourceKey:string; preferencesEvidence:LegacyPreferencesEvidenceRef|null; items:readonly ImportPlannedItem[]}>;

export type ImportItemEvidence = {key:string; state:"pending"|"committed"|"skipped"|"unknown";
  receipt:Receipt<SettingsRevision|RecordRevision>|null; skipReason:string|null;
  publicationTicket:PublicationTicket|null};

export interface DurableImportPort {
  load(owner: PersistenceOwner, id: string): Promise<{plan:ImportPlan;
    items:readonly ImportItemEvidence[]; complete:boolean}|null>;
  plan(owner: PersistenceOwner, plan: ImportPlan): Promise<void>;
  admit(owner: PersistenceOwner, id:string, key:string): Promise<PublicationTicket>;
  tagImport(ticket: PublicationTicket, tag: ImportTag): Promise<void>;
  importReceipts(owner: PersistenceOwner, id:string): Promise<readonly {
    tag:ImportTag; ticket:PublicationTicket; receipt:Receipt<SettingsRevision|RecordRevision>;
  }[]>;
  record(owner: PersistenceOwner, id:string, evidence:ImportItemEvidence): Promise<void>;
  reconcile(ticket: PublicationTicket): ReturnType<PersistenceEnginePort["reconcile"]>;
  complete(owner: PersistenceOwner, id:string): Promise<void>;
}

export interface ExportDestinationRegistry {
  register(input: {action:Handle; scope:CoreWindowScope; nativePath:string;
    deadlineMonotonicMs:number}): Promise<ExportDestination>;
  release(destination: ExportDestination): Promise<void>;
}

export type ExportOutcome = {disposition:"not-committed"|"committed"|"unknown";
  commitId?:Handle; durability?:Durability};

export interface PersistenceOutputPort {
  begin(id:Handle, owner:ResourceOwner, destination:ExportDestination,
    bytes:number, sha256:Sha256, deadlineMonotonicMs:number): Promise<void>;
  append(id:Handle, offset:number, bytes:Uint8Array): Promise<number>;
  commit(id:Handle): Promise<ExportOutcome>;
  reconcile(id:Handle): Promise<ExportOutcome>;
  abort(id:Handle): Promise<"aborted"|"committed"|"unknown">;
}

export type PersistenceScope = {kind:"namespace"; owner:PersistenceOwner}
  | {kind:"target"; owner:PersistenceOwner; recordId:RecordId};

export type PersistenceBarrier = Readonly<{id:Handle; scope:PersistenceScope; through:Counter;
  deadlineMonotonicMs:number}>;

export type PersistenceBarrierEvidence = {state:"saved"|"failed"|"unknown";
  accepted:readonly Handle[]; incomplete:readonly Handle[]; unknown:readonly Handle[]};

export type StoredRecovery = Readonly<{id:Handle; owner:PersistenceOwner; report:DrainReport;
  ticket:PublicationTicket|null; sealedPin:Handle|null; expiresAt:Timestamp|null}>;

export interface PersistenceEvidencePort {
  capture(scope:PersistenceScope, deadlineMonotonicMs:number): PersistenceBarrier;
  flush(barrier:PersistenceBarrier): Promise<PersistenceBarrierEvidence>;
  tickets(barrier:PersistenceBarrier): readonly PublicationTicket[];
  quota(owner:PersistenceOwner): Promise<StorageRequestMap["storage/quota"]["result"]>;
  settingsDigest(owner:PersistenceOwner): Promise<{schemaVersion:Version;
    validationDigest:Sha256; revision:SettingsRevision}|null>;
  auxiliary(owner:PersistenceOwner, kind:"import"|"recovery", key:string): Promise<Uint8Array|null>;
  auxiliaryKeys(owner:PersistenceOwner, kind:"import"|"recovery", cursor?:Handle): Promise<{
    keys:readonly string[];nextCursor:Handle|null;
  }>;
  recoveryPage(cursor?:Handle): Promise<{items:readonly StoredRecovery[]; nextCursor:Handle|null}>;
  loadRecovery(id:Handle): Promise<StoredRecovery|null>;
  saveRecovery(value:StoredRecovery): Promise<void>;
  removeRecovery(id:Handle): Promise<void>;
}
