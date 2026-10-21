import { createHash } from "node:crypto";
import type { DeviceDrainGrant, ReservationBinding } from "@kobrixa/plugin-runtime";
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
// Host-only continuations. Never exposed through a plugin request map.
export type FinalWriteGrant = Readonly<{ owner: PersistenceOwner; recordId: RecordId;
  checkpoint: Handle; token: Handle; deadlineMonotonicMs: number;
  deviceDrain?: DeviceDrainGrant }>;
export type SealedPayloadPin = Readonly<{ pin: Handle; expiresMonotonicMs: number }>;
export interface PersistenceEnginePort {
  reserveFinal?(ticket: PublicationTicket, byteLength: number, grant: FinalWriteGrant): Promise<void>;
  publishRecovery?(ticket: PublicationTicket, sealedPin: Handle, deadlineMonotonicMs: number): ReturnType<PersistenceEnginePort["publish"]>;
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

export type CheckpointRegistration = Readonly<{checkpoint:Handle;record:RecordMeta;
  binding:ReservationBinding|null;state:"open"|"final"|"interrupted"}>;
export interface PersistenceEvidencePort {
  /** Preserve the captured identities for bounded drain reconciliation, without extending its deadline. */
  captureDrain?(scope:PersistenceScope, deadlineMonotonicMs:number):PersistenceBarrier;
  saveCheckpoint?(owner:PersistenceOwner, value:CheckpointRegistration):Promise<void>;
  retainSealed?(ticket: PublicationTicket): Promise<SealedPayloadPin>;
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

import { performance } from "node:perf_hooks";
export const ownerKey = (owner: PersistenceOwner): string => JSON.stringify([owner.sourceKey, owner.pluginId, owner.generation, owner.hostEpoch, owner.processEpoch]);
export class PublicationGate {
  readonly memory: SharedArrayBuffer; private readonly words: BigInt64Array;
  constructor(deadline: number, memory?: SharedArrayBuffer, byteOffset=0, initialize=memory===undefined) {
    this.memory = memory ?? new SharedArrayBuffer(16); this.words = new BigInt64Array(this.memory,byteOffset,2);
    if (initialize) { Atomics.store(this.words, 0, 0n); Atomics.store(this.words, 1, BigInt(Math.floor(deadline))); }
  }
  get deadline(): number { return Number(Atomics.load(this.words, 1)); }
  get dispatched(): boolean { return Atomics.load(this.words, 0) === 1n; }
  shorten(deadline: number, now = performance.now()): void {
    if (deadline <= now) Atomics.compareExchange(this.words, 0, 0n, 2n);
    const value = BigInt(Math.floor(deadline)); let old = Atomics.load(this.words, 1);
    while (value < old) { const seen = Atomics.compareExchange(this.words, 1, old, value); if (seen === old) break; old = seen; }
  }
  dispatch(now: number): boolean {
    if (now >= this.deadline) return false;
    if (Atomics.compareExchange(this.words, 0, 0n, 1n) !== 0n) return false;
    // fence() only shortens time; the atomic state transition is the authority boundary.
    return true;
  }
}

/** Durable metadata correlation only; this identifier grants no publication/read authority. */
export function checkpointRecoveryId(checkpoint: Handle): Handle {
  const digest=createHash("sha256").update("checkpoint-recovery:"+checkpoint).digest("hex");
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
}
