import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNodePersistenceFs } from "./filesystem.js";
import { Namespace } from "./namespace.js";
it("uses the full source hash and verifies stored identity, not plugin ID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "namespace-"));
  try {
    const fs = await createNodePersistenceFs(root, { hostEpoch: "00000000-0000-4000-8000-000000000001", assertHeld() {} });
    const ns = await Namespace.open(fs, "builtin:kobrixa.lab");
    expect(ns.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await Namespace.open(fs, "builtin:kobrixa.lab")).hash).toBe(ns.hash);
    await writeFile(fs.name(ns.path("identity.json")), JSON.stringify({ formatVersion: 1, sourceKey: "foreign" }));
    await expect(Namespace.open(fs, "builtin:kobrixa.lab")).rejects.toThrow("identity-mismatch");
    await writeFile(fs.name(ns.path("identity.json")), JSON.stringify({ formatVersion: 2, sourceKey: "builtin:kobrixa.lab" }));
    await expect(Namespace.open(fs, "builtin:kobrixa.lab")).rejects.toThrow("unsupported-format");
  } finally { await rm(root, { recursive: true, force: true }); }
});
import { randomUUID,createHash } from "node:crypto";
import { importPlanSchema,importDocumentSchema,importItemEvidenceSchema,sameImportValue } from "./namespace.js";
it("strictly validates immutable plan identity, evidence references and complete attempt associations",()=>{
  const owner={sourceKey:"builtin:kobrixa.lab",pluginId:"kobrixa.lab",hostEpoch:randomUUID(),processEpoch:randomUUID(),generation:1};
  const descriptorId="x".repeat(128),id="import/"+createHash("sha256").update(JSON.stringify([descriptorId,owner.sourceKey])).digest("hex"),digest="0".repeat(64);
  const ticket={id:randomUUID(),owner,deadlineMonotonicMs:10000,target:{kind:"settings",expectedRevision:null},metadata:{kind:"settings",schemaVersion:1,validationDigest:digest}};
  const item={key:"settings",sourceFormat:1,sourceSha256:digest,mappedSha256:digest,byteLength:0,ticket,tag:{importId:id,itemKey:"settings",sourceSha256:digest}};
  const plan={formatVersion:1,id,descriptorId,mappingVersion:1,targetSourceKey:owner.sourceKey,preferencesEvidence:{nonce:randomUUID(),digest},items:[item]};
  expect(importPlanSchema.safeParse(plan).success).toBe(true);
  for(const invalid of [{...plan,id:"import/"+digest},{...plan,extra:1},{...plan,items:[item,item]},{...plan,preferencesEvidence:{...plan.preferencesEvidence,raw:[]}},{...plan,preferencesEvidence:{nonce:"invalid",digest}}])expect(importPlanSchema.safeParse(invalid).success).toBe(false);
  const evidence={key:item.key,state:"pending",receipt:null,skipReason:null,publicationTicket:null};
  const doc={formatVersion:1,plan,items:[evidence],complete:false};expect(importDocumentSchema.safeParse(doc).success).toBe(true);
  for(const invalid of [{...doc,complete:true},{...doc,items:[]},{...doc,items:[{...evidence,key:"foreign"}]},{...doc,items:[{...evidence,publicationTicket:{...ticket,metadata:{...ticket.metadata,schemaVersion:2}}}]}])expect(importDocumentSchema.safeParse(invalid).success).toBe(false);
  for(const invalid of [{...evidence,state:"unknown"},{...evidence,state:"committed"},{...evidence,state:"skipped",skipReason:""},{...evidence,state:"skipped",skipReason:"x".repeat(257)}])expect(importItemEvidenceSchema.safeParse(invalid).success).toBe(false);
  expect(sameImportValue(ticket,{metadata:ticket.metadata,target:ticket.target,deadlineMonotonicMs:10000,owner,id:ticket.id})).toBe(true);
  expect(sameImportValue(ticket,{...ticket,owner:{...owner,generation:2}})).toBe(false);
});
