import { expectTypeOf, it } from "vitest";
import type { Handle, RecordId, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import type { PersistenceEnginePort, PersistenceReadPort, PublicationTicket } from "./engine-port.js";
import type { PersistenceFsPort, StoreFd, StorePath } from "./filesystem.js";
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
  PersistenceBackend } from "./engine-port.js";
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
it("pins byte I/O, immutable publication tickets and generation-bound read pins", () => {
  expectTypeOf<PersistenceFsPort["open"]>().toEqualTypeOf<(p: StorePath, mode: "read" | "create-exclusive") => Promise<StoreFd>>();
  expectTypeOf<PersistenceEnginePort["fence"]>().toEqualTypeOf<(owner: PersistenceOwner, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["fenceTarget"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, deadline: number) => readonly Handle[]>();
  expectTypeOf<PersistenceEnginePort["reconcile"]>().toEqualTypeOf<(ticket: PublicationTicket) => ReturnType<PersistenceEnginePort["publish"]>>();
  expectTypeOf<PersistenceReadPort["open"]>().toEqualTypeOf<(owner: PersistenceOwner, id: RecordId, revision: RecordRevision) => Promise<Handle>>();
});
