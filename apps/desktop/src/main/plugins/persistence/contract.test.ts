import { expect, expectTypeOf, it } from "vitest";
import type { Handle, RecordId, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import { type PersistenceBackend, type PersistenceEnginePort, type PersistenceReadPort, type PublicationTicket } from "./engine-port.js";
import type { PersistenceFsPort, StoreFd, StorePath } from "./filesystem.js";
import type { AtomicStore } from "./atomic-store.js";
it("keeps the frozen host ports unchanged", () => {
  expectTypeOf<PersistenceFsPort["open"]>().toEqualTypeOf<(p: StorePath, mode: "read" | "create-exclusive") => Promise<StoreFd>>();
  expectTypeOf<PersistenceEnginePort["fence"]>().toEqualTypeOf<(owner: PersistenceOwner, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["fenceTarget"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["reconcile"]>().toEqualTypeOf<(ticket: PublicationTicket) => ReturnType<PersistenceEnginePort["publish"]>>();
  expectTypeOf<PersistenceReadPort["open"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, revision: RecordRevision) => Promise<Handle>>();
  expectTypeOf<AtomicStore>().toExtend<PersistenceEnginePort & PersistenceReadPort>();
});
it("passes the backend explicitly and retains each concrete port", () => {
  expectTypeOf<PersistenceBackend["imports"]["reconcile"]>().toEqualTypeOf<PersistenceEnginePort["reconcile"]>();
  expectTypeOf<PersistenceBackend["evidence"]["capture"]>().returns.toHaveProperty("scope");
});

import type * as RuntimeRoot from "@kobrixa/plugin-runtime";
import type * as FrozenForms from "../../../../../../packages/plugin-runtime/src/settings-form-port.js";
it("consumes the built runtime form types through its package root", () => {
  expectTypeOf<RuntimeRoot.SettingsFormBinding>().toEqualTypeOf<FrozenForms.SettingsFormBinding>();
  expectTypeOf<RuntimeRoot.SettingsFormPort>().toEqualTypeOf<FrozenForms.SettingsFormPort>();
  expectTypeOf<RuntimeRoot.BoundSettingsService>().toEqualTypeOf<FrozenForms.BoundSettingsService>();
  expectTypeOf<RuntimeRoot.ContributedSettingsForm>().toEqualTypeOf<FrozenForms.ContributedSettingsForm>();
  expectTypeOf<RuntimeRoot.SettingsFieldMap>().toEqualTypeOf<FrozenForms.SettingsFieldMap>();
});
import type { DurableImportPort, ImportPlan, ImportItemEvidence, LegacyPreferencesEvidenceRef,
  } from "./engine-port.js";
import type { LegacySourceResolver, LegacyImportDescriptor, LegacyWriterPort, LegacyWriterBarrier } from "./import-sources.js";
import type { createLegacyWriterBarrier } from "./import-sources.js";
it("pins BM-24/25 host-only admission and renderer evidence contracts",()=>{
  expectTypeOf<DurableImportPort["admit"]>().toEqualTypeOf<(owner:PersistenceOwner,id:string,key:string)=>Promise<PublicationTicket>>();
  expectTypeOf<ImportItemEvidence["publicationTicket"]>().toEqualTypeOf<PublicationTicket|null>();
  expectTypeOf<ImportPlan["preferencesEvidence"]>().toEqualTypeOf<LegacyPreferencesEvidenceRef|null>();
  expectTypeOf<LegacySourceResolver["resolvePreferences"]>().toEqualTypeOf<(input:{descriptorId:string;owner:PersistenceOwner;evidence:LegacyPreferencesEvidenceRef})=>Promise<void>>();
  expectTypeOf<typeof createLegacyWriterBarrier>().toEqualTypeOf<(input:{backend:PersistenceBackend;
    descriptors:readonly Pick<LegacyImportDescriptor,"id"|"targetSourceKey">[];writers:readonly LegacyWriterPort[];
    importOwner:(sourceKey:string)=>PersistenceOwner})=>LegacyWriterBarrier>();
});

import type { ImportTag } from './engine-port.js';
import type { LegacyPreferencesSnapshot, LegacyPreferenceChallenge } from './import-sources.js';
import type { CoreWindowScope } from '@kobrixa/plugin-runtime';
import type { RecordMeta, SettingsRevision, Version, Sha256 } from '@kobrixa/plugin-protocol';
import { PLUGIN_API_VERSION } from '@kobrixa/plugin-protocol';
it('preserves ticket, tag, renderer DTOs and the unpublished wire version',()=>{
  expectTypeOf<PublicationTicket>().toEqualTypeOf<Readonly<{id:Handle;owner:PersistenceOwner;deadlineMonotonicMs:number;
    metadata:{kind:'settings';schemaVersion:Version;validationDigest:Sha256}|{kind:'record';record:RecordMeta;deleted:boolean}|{kind:'recovery'|'import';key:string};
    target:{kind:'settings';expectedRevision:SettingsRevision|null}|{kind:'record';id:RecordId;expectedRevision:RecordRevision|null}|{kind:'recovery'|'import';key:string}}>>();
  expectTypeOf<ImportTag>().toEqualTypeOf<Readonly<{importId:string;itemKey:string;sourceSha256:Sha256}>>();
  expectTypeOf<LegacyPreferencesSnapshot>().toEqualTypeOf<{nonce:Handle;scope:CoreWindowScope;entries:Array<{key:string;raw:string|null}>}>();
  expectTypeOf<LegacyPreferenceChallenge>().toEqualTypeOf<Readonly<{nonce:Handle;scope:CoreWindowScope;descriptorId:string;keys:readonly string[]}>>();
  expect(PLUGIN_API_VERSION).toBe('1.5.0');
});
it('typed backend doubles supply admission and durable preference resolution',async()=>{
  const owner:PersistenceOwner={sourceKey:'builtin:test',pluginId:'test',generation:1,hostEpoch:'00000000-0000-4000-8000-000000000001',processEpoch:'00000000-0000-4000-8000-000000000002'};
  const ticket:PublicationTicket={id:owner.hostEpoch,owner,deadlineMonotonicMs:10,target:{kind:'settings',expectedRevision:null},metadata:{kind:'settings',schemaVersion:1,validationDigest:'0'.repeat(64)}};
  const calls:unknown[]=[];
  const backend:Pick<PersistenceBackend,'imports'|'sources'>={
    imports:{load:async()=>null,plan:async()=>{},admit:async(o,id,key)=>{calls.push([o,id,key]);return ticket;},tagImport:async()=>{},importReceipts:async()=>[],record:async()=>{},reconcile:async()=>({disposition:'not-committed'}),complete:async()=>{}},
    sources:{resolvePreferences:async input=>{calls.push(input);},register:async()=>{},map:async()=>{throw new Error('unused');},appendMapped:async()=>({nextOffset:0,done:true}),releaseMapped:async()=>{},inventory:async()=>({state:'blocked',entries:[]}),read:async()=>new Uint8Array()},
  };
  const evidence={nonce:ticket.id,digest:'0'.repeat(64)};
  expect(await backend.imports.admit(owner,'import/test','one')).toBe(ticket);
  await backend.sources.resolvePreferences({descriptorId:'test',owner,evidence});
  expect(calls).toEqual([[owner,'import/test','one'],{descriptorId:'test',owner,evidence}]);
});
