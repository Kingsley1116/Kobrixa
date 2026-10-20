import { expect, expectTypeOf, it } from "vitest";
import type { Handle, RecordId, RecordRevision } from "@kobrixa/plugin-protocol";
import type { PersistenceOwner } from "@kobrixa/plugin-runtime";
import { type PersistenceBackend, type PersistenceEnginePort, type PersistenceReadPort, type PublicationTicket } from "./engine-port.js";
import type { PersistenceFsPort, StoreFd, StorePath } from "./filesystem.js";
import { AtomicStore } from "./atomic-store.js";
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
