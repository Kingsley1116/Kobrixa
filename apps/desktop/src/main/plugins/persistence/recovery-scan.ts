import { z } from "zod";
import { receiptSchema } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import { createHash, randomUUID } from "node:crypto";
import type { ImportPlannedItem, PublicationTicket } from "./engine-port.js";
import type { StorePath } from "./filesystem.js";
import {
  type Namespace,
  type Location,
  parseHead,
  assertDiskFormat,
  liveRecord,
  publicationTicketSchema,
  sameImportValue,
  type DiskHead,
  importDocumentSchema,
} from "./namespace.js";
import { parseNonceDocument, parseBarrierDocument } from "./import-sources.js";
export function isFirstImportPlan(target: PublicationTicket["target"]): boolean {
  return target.kind === "import" && /^import\/[0-9a-f]{64}$/.test(target.key);
}
// Earlier ordinary reserves wrote the caller's ticket directly. A private
// reserve always serializes the schema-parsed ticket in schema field order.
export async function legacyImportReserve(
  ns: Namespace,
  id: string,
  rawTicket: unknown,
  ticket: PublicationTicket,
) {
  if (JSON.stringify(rawTicket) === JSON.stringify(ticket)) return false;
  const files = await ns.fs.entries(ns.path("staging", id), 4096);
  // Ordinary cleanup may itself stop after unlinking the payload or while
  // writing its resolution. Both cuts still have the same installed intent.
  return files.every(
    (file) =>
      !file.directory &&
      ["intent.json", "payload.tmp", "resolved.tmp", "resolved.json"].includes(file.name),
  );
}
export type NamespaceScan = {
  heads: DiskHead[];
  problems: string[];
  totals: { committed: number; records: number; metadata: number; temporary: number };
};
const contentError = (e: unknown): boolean =>
  e instanceof Error &&
  (e.message === "corrupt" || e instanceof SyntaxError || e instanceof TypeError);
const resolvedSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    formatVersion: z.literal(1),
    disposition: z.literal("committed"),
    receipt: receiptSchema,
  }),
  z.strictObject({
    formatVersion: z.literal(1),
    disposition: z.literal("not-committed"),
    receipt: z.null(),
  }),
]);
export function exactDocument(bytes: Uint8Array, expected: unknown): boolean {
  return Buffer.from(JSON.stringify(expected)).equals(bytes);
}
function recordCandidate(
  ticket: PublicationTicket,
  tag: NonNullable<DiskHead["importTag"]>,
  durability: DiskHead["receipt"]["durability"],
) {
  if (ticket.metadata.kind !== "record") throw new Error("corrupt");
  const record = ticket.metadata.record;
  return {
    formatVersion: 1,
    metadata: ticket.metadata,
    target: ticket.target,
    object: record.revision + ".bin",
    byteLength: record.byteLength,
    sha256: record.sha256,
    receipt: { revision: record.revision, commitId: ticket.id, durability },
    importTag: tag,
  };
}
export function canonicalHead(bytes: Uint8Array): DiskHead {
  const head = parseHead(bytes);
  if (!exactDocument(bytes, head)) throw new Error("corrupt");
  return head;
}
function readJson(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}
export async function resolvedImport(ns: Namespace, id: string, privatePlan: boolean) {
  const path = ns.path("staging", id, "resolved.json");
  if (!(await ns.fs.exists(path))) return null;
  const bytes = await ns.fs.bytes(path, 8192);
  const value = resolvedSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (privatePlan && !exactDocument(bytes, value)) throw new Error("corrupt");
  return value;
}
async function persistResolution(
  ns: Namespace,
  id: string,
  value: z.infer<typeof resolvedSchema>,
): Promise<void> {
  const temp = ns.path("staging", id, "resolved.tmp");
  if (await ns.fs.exists(temp)) await ns.fs.unlink(temp);
  await ns.writeNew(temp, resolvedSchema.parse(value));
  await ns.fs.atomicReplace(temp, ns.path("staging", id, "resolved.json"));
  await ns.fs.syncDirectory(ns.path("staging", id));
}
// Compare bounded chunks from both open files and authenticate their common contents.
async function verifyDuplicate(
  ns: Namespace,
  staged: StorePath,
  installed: StorePath,
  head: DiskHead,
) {
  const fs = ns.fs;
  const left = await fs.openOwned(staged, "read");
  try {
    const right = await fs.openOwned(installed, "read");
    try {
      const a = await fs.fileStamp(left, staged),
        b = await fs.fileStamp(right, installed);
      if (a.size !== head.byteLength || b.size !== a.size) throw new Error("corrupt");
      const digest = createHash("sha256");
      const first = Buffer.allocUnsafe(262144),
        second = Buffer.allocUnsafe(262144);
      for (let offset = 0; offset < a.size;) {
        const length = Math.min(first.length, a.size - offset);
        const x = await fs.readInto(left, offset, first.subarray(0, length));
        if (!x.length) throw new Error("corrupt");
        const y = await fs.readInto(right, offset, second.subarray(0, x.length));
        if (!y.length || !first.subarray(0, y.length).equals(y)) throw new Error("corrupt");
        digest.update(y);
        offset += y.length;
      }
      if (
        digest.digest("hex") !== head.sha256 ||
        (await fs.fileStamp(left, staged)).identity !== a.identity ||
        (await fs.fileStamp(right, installed)).identity !== b.identity
      )
        throw new Error("corrupt");
    } finally {
      await fs.closeOwned(right);
    }
  } finally {
    await fs.closeOwned(left);
  }
}
async function checkQuarantineNames(ns: Namespace): Promise<void> {
  const entries = await ns.fs.entries(ns.path("quarantine"), 4096);
  if (
    entries.some(
      (entry) =>
        entry.directory ||
        !/^[0-9a-f-]{36}\.(evidence|prepublish\.bin|prepublish-head)$/.test(entry.name),
    )
  )
    throw new Error("corrupt");
}
async function readImportJournal(ns: Namespace, head: DiskHead) {
  if (head.target.kind !== "import") throw new Error("corrupt");
  const loc = await ns.location(head.target);
  if (!exactDocument(await ns.fs.bytes(loc.head, 8192), head)) throw new Error("corrupt");
  const bytes = await ns.fs.bytes(ns.object(loc, head), 2097152);
  if (
    bytes.length !== head.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== head.sha256
  )
    throw new Error("corrupt");
  const journal = importDocumentSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (journal.plan.id !== head.target.key || journal.plan.targetSourceKey !== ns.sourceKey)
    throw new Error("identity-mismatch");
  return journal;
}
// A first imported record can have its immutable object and temporary head on disk
// before the head rename. Only the durable pending journal can authorize classifying
// that exact candidate as uncommitted; never promote it or infer an empty default.
// The journal also survives older recovery scans that already removed staging intent.
export async function retirePendingImportCandidate(
  ns: Namespace,
  loc: Location,
  live?: {
    ticket: PublicationTicket;
    head: DiskHead | null;
    installedCandidate: boolean;
    tag: NonNullable<DiskHead["importTag"]>;
    reserveQuarantine: (path: StorePath, bytes: number) => void;
  },
): Promise<false | { temporary: number; metadata: number }> {
  const cleared = { temporary: 0, metadata: 0 };
  const fs = ns.fs;
  if (loc.parts[0] !== "records" || (await fs.exists(loc.head)) || (await fs.exists(loc.previous)))
    return false;
  const entries = await fs.entries(loc.directory, 4096);
  const candidates = entries.filter((entry) => !(entry.directory && entry.name === "objects"));
  const objects = await fs.entries(loc.objects, 4096);
  if (live && candidates.length === 0 && !live.installedCandidate && objects.length === 0) {
    // A reserve/seal/partial staging write has not installed a candidate. The live
    // ticket still owns its payload. A vanished installed candidate cannot use this path.
    if (
      !(await fs.exists(ns.path("staging", live.ticket.id, "payload.tmp"))) ||
      (await fs.exists(ns.path("quarantine", live.ticket.id + ".prepublish.bin"))) ||
      (await fs.exists(ns.path("quarantine", live.ticket.id + ".prepublish-head")))
    )
      return false;
    const ticket = live.ticket;
    if (ticket.metadata.kind !== "record") return false;
    for (const [name, expected] of [
      [
        "intent.json",
        {
          formatVersion: 1,
          ticket,
          byteLength: ticket.metadata.record.byteLength,
          predecessor: null,
        },
      ],
      ["import-tag.json", { formatVersion: 1, tag: live.tag }],
    ] as const) {
      const bytes = await fs.bytes(ns.path("staging", ticket.id, name), 32768);
      if (!exactDocument(bytes, expected)) return false;
    }
    const entries = await fs.entries(ns.path("staging", ticket.id), 4096);
    for (const entry of entries) {
      if (entry.directory) return false;
      if (["intent.json", "import-tag.json", "payload.tmp"].includes(entry.name)) continue;
      const expected =
        entry.name === "publication.json"
          ? live.head
          : entry.name === "sealed.json"
            ? {
                formatVersion: 1,
                byteLength: ticket.metadata.record.byteLength,
                sha256: ticket.metadata.record.sha256,
              }
            : null;
      if (
        !expected ||
        !exactDocument(await fs.bytes(ns.path("staging", ticket.id, entry.name), 8192), expected)
      )
        return false;
    }
    if (live.head) await ns.verifyObject(ns.path("staging", ticket.id, "payload.tmp"), live.head);
    return cleared;
  }
  if (candidates.length !== 1) return false;
  const file = candidates[0]!;
  if (file.directory || !/^head\.[0-9a-f-]{36}\.tmp$/.test(file.name)) return false;
  const candidateBytes = await fs.bytes(ns.path(...loc.parts, file.name), 8192);
  const candidate = parseHead(candidateBytes);
  if (
    candidate.target.kind !== "record" ||
    candidate.target.expectedRevision !== null ||
    candidate.target.id !== loc.parts[1] ||
    candidate.metadata.kind !== "record" ||
    candidate.metadata.deleted ||
    candidate.object !== candidate.receipt.revision + ".bin" ||
    !candidate.importTag ||
    !exactDocument(candidateBytes, candidate) ||
    file.name !== `head.${candidate.receipt.commitId}.tmp` ||
    (live && !sameImportValue(live.head, candidate)) ||
    objects.length > 1 ||
    (objects.length === 1 && (objects[0]!.directory || objects[0]!.name !== candidate.object))
  )
    return false;
  const journalLoc = await ns.location({ kind: "import", key: candidate.importTag.importId });
  const journalHead = await ns.head(journalLoc);
  if (
    !journalHead ||
    journalHead.target.kind !== "import" ||
    journalHead.target.key !== candidate.importTag.importId
  )
    return false;
  const journal = await readImportJournal(ns, journalHead);
  if (journal.complete) return false;
  const index = journal.plan.items.findIndex((i) => i.key === candidate.importTag!.itemKey);
  if (index < 0) return false;
  const item = journal.plan.items[index]!,
    evidence = journal.items[index]!,
    attempt = evidence.publicationTicket;
  if (
    evidence.state !== "pending" ||
    evidence.receipt !== null ||
    !attempt ||
    !exactDocument(candidateBytes, recordCandidate(attempt, item.tag, fs.durability)) ||
    attempt.owner.sourceKey !== ns.sourceKey ||
    attempt.id !== candidate.receipt.commitId ||
    (live && !sameImportValue(live.ticket, attempt)) ||
    !sameImportValue(attempt.target, candidate.target) ||
    !sameImportValue(attempt.metadata, candidate.metadata) ||
    !sameImportValue(item.tag, candidate.importTag) ||
    item.byteLength !== candidate.byteLength ||
    item.mappedSha256 !== candidate.sha256
  )
    return false;
  // A renamed, durable stage tag distinguishes an abort from baseline startup quarantine.
  // A crash between the moves leaves no published head and cannot replay payload.
  await checkQuarantineNames(ns);
  const objectEvidence = ns.path("quarantine", `${candidate.receipt.commitId}.prepublish.bin`);
  const headEvidence = ns.path("quarantine", `${candidate.receipt.commitId}.prepublish-head`);
  if (await fs.exists(headEvidence)) throw new Error("corrupt");
  const staged = ns.path("staging", attempt.id, "payload.tmp");
  // Older scans could retire the entire staging directory. Where it survives,
  // validate every name and its ticket binding before mutating either location.
  const stageDir = ns.path("staging", attempt.id);
  const stagedExists = await fs.exists(staged);
  const stageExists = await fs.exists(stageDir);
  const abortTag = ns.path("staging", attempt.id, "abort-tag.json");
  const aborting = await fs.exists(abortTag);
  if (aborting && (live || stagedExists)) return false;
  if (stageExists) {
    const contents = await fs.entries(stageDir, 4096);
    const documents = new Map<string, unknown>([
      [
        "intent.json",
        { formatVersion: 1, ticket: attempt, byteLength: item.byteLength, predecessor: null },
      ],
      ["sealed.json", { formatVersion: 1, byteLength: item.byteLength, sha256: item.mappedSha256 }],
      [aborting ? "abort-tag.json" : "import-tag.json", { formatVersion: 1, tag: item.tag }],
    ]);
    if (contents.some((e) => e.directory || (e.name !== "payload.tmp" && !documents.has(e.name))))
      return false;
    for (const [name, expected] of documents) {
      // Historical scans could already have removed some staging documents.
      if (!live && !aborting && !stagedExists && !contents.some((entry) => entry.name === name))
        continue;
      const actual = await fs.bytes(ns.path("staging", attempt.id, name), 32768);
      if (!aborting && !live && (name === "sealed.json" || name === "import-tag.json")) {
        // Candidate and journal already establish ownership. Shared sidecars
        // corroborate their values using the original record reader.
        const encoded = Buffer.from(JSON.stringify(expected));
        if (encoded.subarray(0, actual.length).equals(actual)) continue;
        if (!sameImportValue(JSON.parse(Buffer.from(actual).toString("utf8")), expected))
          return false;
      } else if (!exactDocument(actual, expected)) return false;
    }
  } else if (live) return false;
  if (stagedExists && (await fs.exists(objectEvidence))) return false;
  if (stagedExists && !objects.length) {
    await ns.verifyObject(staged, candidate);
    await fs.unlink(ns.path(...loc.parts, file.name));
    await fs.syncDirectory(loc.directory);
    return cleared;
  }
  if (stagedExists) {
    await verifyDuplicate(ns, staged, ns.object(loc, candidate), candidate);
    await fs.unlink(staged);
    await fs.syncDirectory(ns.path("staging", attempt.id));
  }
  if (objects.length === 0) {
    // Interrupted after the quarantine move. Never overwrite existing evidence.
    if (!(await fs.exists(objectEvidence))) return false;
    await ns.verifyObject(objectEvidence, candidate);
  } else {
    if (await fs.exists(objectEvidence)) throw new Error("corrupt");
    await ns.verify(loc, candidate);
  }
  if (live) {
    await fs.atomicReplace(ns.path("staging", attempt.id, "import-tag.json"), abortTag);
  }
  if (live || aborting) await fs.syncDirectory(stageDir);
  live?.reserveQuarantine(objectEvidence, candidate.byteLength);
  if (objects.length) {
    await fs.atomicReplace(ns.object(loc, candidate), objectEvidence);
  }
  await fs.syncDirectory(ns.path("quarantine"));
  await fs.syncDirectory(loc.objects);
  await fs.atomicReplace(ns.path(...loc.parts, file.name), headEvidence);
  await fs.syncDirectory(ns.path("quarantine"));
  await fs.syncDirectory(loc.directory);
  if (live || aborting) {
    await removeAbortedEvidence(ns, objectEvidence, headEvidence);
    return cleared;
  }
  return { temporary: candidate.byteLength, metadata: file.bytes };
}
// The head witnesses an interrupted payload unlink until the quarantine barrier succeeds.
async function removeAbortedEvidence(ns: Namespace, object: StorePath, head: StorePath) {
  const fs = ns.fs,
    quarantine = ns.path("quarantine");
  if (await fs.exists(object)) await fs.unlink(object);
  await fs.syncDirectory(quarantine);
  await fs.unlink(head);
  await fs.syncDirectory(quarantine);
}
// reserve writes the initial intent before creating payload.tmp. An interrupted
// write can leave only a prefix. The verified journal supplies the complete
// expected intent; an unknown ticket or any sign of publication precludes repair.
async function interruptedReserveIntent(
  ns: Namespace,
  id: string,
  prefix: Uint8Array,
  hostEpoch: string,
  heads: readonly DiskHead[],
): Promise<boolean> {
  const fs = ns.fs;
  const stage = ns.path("staging", id);
  const files = await fs.entries(stage, 4096);
  if (files.length !== 1 || files[0]?.name !== "import-record-intent.tmp") return false;
  let match = false;
  for (const head of heads) {
    if (!isFirstImportPlan(head.target)) continue;
    const journal = await readImportJournal(ns, head);
    if (journal.complete) continue;
    for (const [index, evidence] of journal.items.entries()) {
      const ticket = evidence.publicationTicket;
      if (ticket?.id !== id) continue;
      if (
        match ||
        evidence.state !== "pending" ||
        evidence.receipt !== null ||
        ticket.owner.sourceKey !== ns.sourceKey ||
        ticket.owner.hostEpoch === hostEpoch ||
        ticket.target.kind !== "record" ||
        ticket.target.expectedRevision !== null
      )
        return false;
      const expected = Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          ticket,
          byteLength: journal.plan.items[index]!.byteLength,
          predecessor: null,
        }),
      );
      if (
        expected.length > 8192 ||
        prefix.length > expected.length ||
        !expected.subarray(0, prefix.length).equals(prefix)
      )
        return false;
      const record = await ns.location(ticket.target);
      if (
        (await fs.entries(record.directory, 4096)).some(
          (e) => !e.directory || e.name !== "objects",
        ) ||
        (await fs.entries(record.objects, 4096)).length ||
        (await fs.exists(ns.path("quarantine", id + ".prepublish.bin"))) ||
        (await fs.exists(ns.path("quarantine", id + ".prepublish-head")))
      )
        return false;
      match = true;
    }
  }
  return match;
}
const journalSealSchema = z.strictObject({
  formatVersion: z.literal(1),
  byteLength: z.number().int().nonnegative().max(2097152),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

// A prefix can end inside an escaped plugin ID, a UUID, or a number. Complete
// the unknown scalars, then compare the actual bytes with the writer's entire
// canonical serialization. A parse error by itself never authorizes removal.
function prefixText(bytes: Uint8Array): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // Only a UTF-8 scalar split by the last write may need continuation bytes.
  for (const lead of [0x80, 0xa0, 0x90]) {
    for (let n = 0; n <= 3; n++) {
      const suffix = Buffer.alloc(n, 0x80);
      if (n) suffix[0] = lead;
      try {
        return decoder.decode(Buffer.concat([bytes, suffix]));
      } catch {
        /* Try a legal continuation. */
      }
    }
  }
  throw new Error("corrupt");
}

function prefixString(text: string): string {
  const input = text.match(/^"(?:[^"\\]|\\.)*(?:"|\\?$)/s)?.[0] ?? '""';
  // JSON.stringify escapes control characters and unpaired UTF-16 surrogates.
  const escape = /\\u([0-9a-f]{0,3})$/.exec(input);
  const endings = ["", '"', 'x"', 'n"'];
  if (escape)
    for (const code of ["0000", "d800", "dc00"]) endings.push(code.slice(escape[1]!.length) + '"');
  for (const end of endings) {
    try {
      const value: unknown = JSON.parse(input + end);
      if (typeof value === "string" && value && JSON.stringify(value).startsWith(input))
        return value;
    } catch {
      /* Incomplete string. */
    }
  }
  return "x";
}

function prefixNumber(text: string, maximum: number, integer: boolean): number {
  const prefix = /^[\d.e+-]*/.exec(text)![0];
  const matches = (value: number) =>
    value >= 0 &&
    value <= maximum &&
    (!integer || Number.isSafeInteger(value)) &&
    JSON.stringify(value).startsWith(prefix);
  const direct = Number(prefix);
  if (matches(direct)) return direct;
  // Every prefix of a canonical nonnegative integer is already an integer.
  if (integer || prefix.length > 24 || !/^\d+(?:\.\d*)?(?:e-?\d*)?$/.test(prefix)) return 0;
  const [mantissa, exponentPrefix] = prefix.split("e");
  const bits = new DataView(new ArrayBuffer(8));
  // JSON.stringify uses decimal or negative scientific notation in the ticket's
  // range. Check the lower boundary, its next representable double, and an
  // interior value: rounding or stripping trailing zeros can change the prefix.
  for (let exponent = 0; exponent >= -324; exponent--) {
    if (exponent < 0 && exponent > -7) continue;
    if (
      exponentPrefix !== undefined &&
      (exponent === 0 || !String(exponent).startsWith(exponentPrefix))
    )
      continue;
    const scale = "e" + exponent;
    const lower = Number(mantissa + scale);
    if (matches(lower)) return lower;
    if (exponentPrefix !== undefined) continue;
    bits.setFloat64(0, lower);
    bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
    const adjacent = bits.getFloat64(0);
    if (matches(adjacent)) return adjacent;
    const middle = Number(mantissa + "5" + scale);
    if (matches(middle)) return middle;
  }
  return 0;
}

function journalIntentScratch(
  bytes: Uint8Array,
  source: string,
  id: string,
  epoch: string,
  heads: readonly DiskHead[],
): boolean {
  const text = prefixText(bytes);
  // Read fields in writer order. Values are hints for constructing a possible
  // completion only. The final byte comparison checks all names and punctuation.
  let offset = 0;
  function field(name: string) {
    const key = JSON.stringify(name) + ":";
    const found = text.indexOf(key, offset);
    if (found < 0) return "";
    offset = found + key.length;
    return text.slice(offset);
  }
  function uuid(name: string) {
    const part = /^"([a-f0-9-]*)/.exec(field(name))?.[1] ?? "";
    const fill = epoch.endsWith("1")
      ? "00000000-0000-4000-8000-000000000002"
      : "00000000-0000-4000-8000-000000000001";
    return part + fill.slice(part.length);
  }
  field("sourceKey");
  const pluginId = prefixString(field("pluginId"));
  const generation = prefixNumber(field("generation"), Number.MAX_SAFE_INTEGER, true);
  const hostEpoch = uuid("hostEpoch"),
    processEpoch = uuid("processEpoch");
  const deadlineMonotonicMs = prefixNumber(
    field("deadlineMonotonicMs"),
    Number.MAX_SAFE_INTEGER,
    false,
  );
  const hash = /^"import\/([a-f0-9]*)/.exec(field("key"))?.[1] ?? "";
  const target = { kind: "import" as const, key: "import/" + hash.padEnd(64, "0") };
  const checked = publicationTicketSchema.safeParse({
    id,
    owner: { sourceKey: source, pluginId, generation, hostEpoch, processEpoch },
    deadlineMonotonicMs,
    metadata: target,
    target,
  });
  if (!checked.success || hostEpoch === epoch || !isFirstImportPlan(target)) return false;
  const byteLength = prefixNumber(field("byteLength"), 2097152, true);
  const predecessor = heads.find((head) => sameImportValue(head.target, target)) ?? null;
  const expected = Buffer.from(
    JSON.stringify({ formatVersion: 1, ticket: checked.data, byteLength, predecessor }),
  );
  return expected.length <= 8192 && expected.subarray(0, bytes.length).equals(bytes);
}

async function recoverJournalStage(
  ns: Namespace,
  id: string,
  checkedTicket: PublicationTicket,
  intentBytes: Uint8Array,
  problems: string[],
): Promise<void> {
  const fs = ns.fs;
  if (checkedTicket.target.kind !== "import") throw new Error("identity-mismatch");
  if (checkedTicket.id !== id || !sameImportValue(checkedTicket.metadata, checkedTicket.target))
    throw new Error("identity-mismatch");
  const dir = ns.path("staging", id);
  const names = new Set(
    (await fs.entries(dir, 4096)).map((file) => {
      if (
        file.directory ||
        ![
          "intent.json",
          "payload.tmp",
          "sealed.json",
          "publication.json",
          "resolved.json",
          "resolved.tmp",
          "journal-sealed.tmp",
          "journal-publication.tmp",
        ].includes(file.name)
      )
        throw new Error("corrupt");
      return file.name;
    }),
  );
  const raw = readJson(intentBytes);
  if (
    Object.keys(raw).sort().join(",") !== "byteLength,formatVersion,predecessor,ticket" ||
    !Number.isSafeInteger(raw.byteLength) ||
    raw.byteLength < 0 ||
    raw.byteLength > 2097152
  )
    throw new Error("corrupt");
  const predecessor =
    raw.predecessor === null ? null : canonicalHead(Buffer.from(JSON.stringify(raw.predecessor)));
  if (
    !exactDocument(intentBytes, {
      formatVersion: 1,
      ticket: checkedTicket,
      byteLength: raw.byteLength,
      predecessor,
    })
  )
    throw new Error("corrupt");
  const sealBytes = names.has("sealed.json")
    ? await fs.bytes(ns.path("staging", id, "sealed.json"), 8192)
    : null;
  const seal = sealBytes && journalSealSchema.parse(readJson(sealBytes));
  if (sealBytes && !exactDocument(sealBytes, seal)) throw new Error("corrupt");
  if (seal && seal.byteLength !== raw.byteLength) throw new Error("corrupt");
  const candidate = names.has("publication.json")
    ? canonicalHead(await fs.bytes(ns.path("staging", id, "publication.json"), 8192))
    : null;
  if (
    candidate &&
    (!sameImportValue(candidate.target, checkedTicket.target) ||
      !sameImportValue(candidate.metadata, checkedTicket.metadata) ||
      candidate.byteLength !== raw.byteLength ||
      (seal && candidate.sha256 !== seal.sha256))
  )
    throw new Error("identity-mismatch");
  const loc = await ns.location(checkedTicket.target);
  const pendingHead = ns.path(...loc.parts, loc.name + "." + id + ".tmp");
  // The stage publication is installed only after the destination head write
  // has finished. Before the final rename, both copies must agree byte for byte.
  if (
    candidate &&
    (await fs.exists(pendingHead)) &&
    !exactDocument(await fs.bytes(pendingHead, 8192), candidate)
  )
    throw new Error("corrupt");
  const payload = ns.path("staging", id, "payload.tmp");
  const resolved = await resolvedImport(ns, id, true);
  const sealing = names.has("journal-sealed.tmp"),
    publishing = names.has("journal-publication.tmp");
  if (sealing || publishing) {
    if (
      resolved ||
      names.has("resolved.tmp") ||
      candidate ||
      (sealing && (!names.has("payload.tmp") || seal || publishing)) ||
      (publishing && (names.has("payload.tmp") || !seal))
    )
      throw new Error("corrupt");
  }
  if (resolved) {
    // The writer removes the payload before installing the resolution. It may
    // retain the resolution across later publications of the same journal.
    if (
      names.has("resolved.tmp") ||
      names.has("payload.tmp") ||
      (resolved.disposition === "committed" &&
        (resolved.receipt.commitId !== id ||
          (!candidate && seal) ||
          (candidate && !sameImportValue(candidate.receipt, resolved.receipt))))
    )
      throw new Error("corrupt");
    return;
  }
  // Classify verified heads before touching the only persisted association.
  const head = await ns.head(loc);
  if (head) {
    if (!exactDocument(await fs.bytes(loc.head, 8192), head)) throw new Error("corrupt");
    await ns.verify(loc, head);
  }
  if (
    candidate &&
    (candidate.importTag ||
      candidate.object !== candidate.receipt.revision + ".json" ||
      candidate.receipt.commitId !== id)
  )
    throw new Error("corrupt");
  if (candidate && !sameImportValue(candidate, head)) await ns.verify(loc, candidate);
  if (seal && names.has("payload.tmp")) {
    const bytes = await fs.bytes(payload, 2097152);
    if (
      bytes.length !== seal.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== seal.sha256
    )
      throw new Error("corrupt");
  }
  if (predecessor) {
    if (!sameImportValue(predecessor.target, checkedTicket.target))
      throw new Error("identity-mismatch");
    await ns.verify(loc, predecessor);
  }
  let matching = !!candidate && sameImportValue(candidate, head);
  // After committed cleanup removes the publication witness the new head
  // still names the exact private ticket. A legacy unrelated receipt cannot match.
  if (
    !candidate &&
    head?.receipt.commitId === checkedTicket.id &&
    sameImportValue(head.target, checkedTicket.target) &&
    sameImportValue(head.metadata, checkedTicket.metadata) &&
    head.byteLength === raw.byteLength &&
    checkedTicket.target.key.startsWith("import/")
  ) {
    if (seal || names.has("payload.tmp") || sealing || publishing) throw new Error("corrupt");
    await readImportJournal(ns, head);
    matching = true;
  }
  if (!matching && !sameImportValue(head, predecessor)) {
    problems.push("import-uncertain");
    return;
  }
  if (names.has("resolved.tmp")) {
    const expected = matching
      ? { formatVersion: 1, disposition: "committed", receipt: head!.receipt }
      : { formatVersion: 1, disposition: "not-committed", receipt: null };
    const encoded = Buffer.from(JSON.stringify(resolvedSchema.parse(expected)));
    const prefix = await fs.bytes(ns.path("staging", id, "resolved.tmp"), encoded.length);
    if (!encoded.subarray(0, prefix.length).equals(prefix)) throw new Error("corrupt");
  }
  if (sealing || publishing) {
    if (!sameImportValue(head, predecessor)) throw new Error("corrupt");
    const scratch = ns.path(
      "staging",
      id,
      sealing ? "journal-sealed.tmp" : "journal-publication.tmp",
    );
    let expected: Uint8Array;
    if (sealing) {
      const bytes = await fs.bytes(payload, raw.byteLength);
      if (bytes.length !== raw.byteLength) throw new Error("corrupt");
      expected = Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          byteLength: raw.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
    } else {
      // publishOne writes the complete destination candidate before starting the
      // staged witness. Its immutable object and seal must explain the scratch.
      expected = await fs.bytes(ns.path(...loc.parts, loc.name + "." + id + ".tmp"), 8192);
      const staged = parseHead(expected);
      if (
        !seal ||
        !sameImportValue(staged.metadata, checkedTicket.metadata) ||
        !sameImportValue(staged.target, checkedTicket.target) ||
        staged.receipt.commitId !== id ||
        staged.byteLength !== seal.byteLength ||
        staged.sha256 !== seal.sha256 ||
        staged.object !== staged.receipt.revision + ".json" ||
        staged.importTag ||
        !Buffer.from(expected).equals(Buffer.from(JSON.stringify(staged)))
      )
        throw new Error("corrupt");
      await ns.verify(loc, staged);
    }
    const actual = await fs.bytes(scratch, expected.length);
    if (!Buffer.from(expected.subarray(0, actual.length)).equals(actual))
      throw new Error("corrupt");
    await fs.unlink(scratch);
    await fs.syncDirectory(dir);
  }
  if (await fs.exists(payload)) await fs.unlink(payload);
  if (matching) {
    await fs.syncDirectory(loc.directory);
    await persistResolution(ns, id, {
      formatVersion: 1,
      disposition: "committed",
      receipt: head!.receipt,
    });
  } else {
    await persistResolution(ns, id, {
      formatVersion: 1,
      disposition: "not-committed",
      receipt: null,
    });
  }
}
// Check marked attempts before rollback or ordinary stage retirement can mutate their evidence.
async function validateAbortStages(
  ns: Namespace,
  hostEpoch: string,
  marked: Set<string>,
  locations: readonly Location[],
) {
  if (!marked.size) return;
  await checkQuarantineNames(ns);
  const fs = ns.fs;
  const bound = new Set<string>();
  for (const journalLoc of locations) {
    if (journalLoc.parts[0] !== "imports") continue;
    const head = await ns.head(journalLoc);
    if (!head || !isFirstImportPlan(head.target)) continue;
    const journal = await readImportJournal(ns, head);
    if (journal.complete) continue;
    for (const [index, evidence] of journal.items.entries()) {
      const ticket = evidence.publicationTicket;
      if (evidence.state !== "pending" || !ticket || !marked.has(ticket.id)) continue;
      const id = ticket.id;
      if (
        bound.has(id) ||
        ticket.owner.hostEpoch === hostEpoch ||
        ticket.owner.sourceKey !== ns.sourceKey ||
        ticket.target.kind !== "record" ||
        ticket.target.expectedRevision !== null
      )
        throw new Error("corrupt");
      bound.add(id);
      const item = journal.plan.items[index]!;
      const stage = ns.path("staging", id);
      const files = await fs.entries(stage, 4096);
      const loc = await ns.location(ticket.target);
      const entries = await fs.entries(loc.directory, 4096);
      const candidate = `head.${id}.tmp`;
      if (entries.some((e) => (e.directory ? e.name !== "objects" : e.name !== candidate)))
        throw new Error("corrupt");
      const hasCandidate = entries.some((e) => e.name === candidate);
      const hasWitness = await fs.exists(ns.path("quarantine", id + ".prepublish-head"));
      if (
        !hasCandidate &&
        ((await fs.entries(loc.objects, 4096)).length ||
          (!hasWitness && (await fs.exists(ns.path("quarantine", id + ".prepublish.bin")))))
      )
        throw new Error("corrupt");
      const documents = new Map<string, unknown>([
        [
          "intent.json",
          { formatVersion: 1, ticket, byteLength: item.byteLength, predecessor: null },
        ],
        ["abort-tag.json", { formatVersion: 1, tag: item.tag }],
      ]);
      // Only the scanner can remove the seal while the marker survives, after both witnesses are gone.
      if (hasCandidate || hasWitness || files.some((e) => e.name === "sealed.json"))
        documents.set("sealed.json", {
          formatVersion: 1,
          byteLength: item.byteLength,
          sha256: item.mappedSha256,
        });
      if (
        files.length !== documents.size ||
        files.some((e) => e.directory || !documents.has(e.name))
      )
        throw new Error("corrupt");
      for (const [name, expected] of documents) {
        const raw = await fs.bytes(ns.path("staging", id, name), 8192);
        if (!exactDocument(raw, expected)) throw new Error("corrupt");
      }
    }
  }
  if (bound.size !== marked.size) throw new Error("corrupt");
}
export async function scanNamespace(ns: Namespace, hostEpoch: string): Promise<NamespaceScan> {
  const fs = ns.fs;
  fs.profile.assertHeld();
  const result: NamespaceScan = {
    heads: [],
    problems: [],
    totals: { committed: 0, records: 0, metadata: 0, temporary: 0 },
  };
  const inventory = await ns.inventory(); // Bound traversal and reject unsafe aliases before any repair.
  const payloads = new Set<string>(),
    retained = new Set<string>();
  const unresolved = new Set<string>();
  const unresolvedStages = new Set<string>();
  const unresolvedCandidates = new Map<string, Set<string>>();
  const pendingRecords = new Map<
    string,
    { ticket: PublicationTicket; item: ImportPlannedItem }[]
  >();
  const claimedItems = new Set<string>();
  const locations = await ns.locations();
  const stages = await fs.entries(ns.path("staging"), 4096);
  const marked = new Set<string>();
  for (const entry of stages) {
    if (!entry.directory || !/^[0-9a-f-]{36}$/.test(entry.name)) throw new Error("corrupt");
    if (await fs.exists(ns.path("staging", entry.name, "abort-tag.json"))) marked.add(entry.name);
  }
  await validateAbortStages(ns, hostEpoch, marked, locations);
  for (const loc of locations) {
    let head: DiskHead | null = null;
    try {
      head = await ns.head(loc);
      if (head) await ns.verify(loc, head);
    } catch (e) {
      if (!contentError(e)) throw e;
      head = null;
      result.problems.push("corrupt");
      unresolved.add(fs.name(loc.directory));
    }
    if (!head && (await fs.exists(loc.previous))) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192));
      await ns.verify(loc, previous);
      if (await fs.exists(loc.head)) await ns.quarantine(loc.head);
      const restore = ns.path(...loc.parts, `${loc.name}.${randomUUID()}.restore`);
      await ns.writeNew(restore, previous);
      await fs.atomicReplace(restore, loc.head);
      await fs.syncDirectory(loc.directory);
      head = previous;
      result.problems.push("rollback-interrupted");
    }
    if (!head) {
      const objectsRemain =
        (await fs.exists(loc.objects)) && (await fs.entries(loc.objects, 4096)).length > 0;
      const recordEntries = loc.parts[0] === "records" ? await fs.entries(loc.directory, 4096) : [];
      const candidateRemains = recordEntries.some(
        (e) => !e.directory && /^head\.[0-9a-f-]{36}\.tmp$/.test(e.name),
      );
      if ((objectsRemain || candidateRemains) && !(await retirePendingImportCandidate(ns, loc))) {
        result.problems.push("corrupt");
        unresolved.add(fs.name(loc.directory));
        // A mismatched intent cannot point cleanup at a different destination and
        // thereby authorize erasing this candidate's staging evidence.
        for (const entry of recordEntries) {
          const match = /^head\.([0-9a-f-]{36})\.tmp$/.exec(entry.name);
          if (match) {
            const targets = unresolvedCandidates.get(match[1]!) ?? new Set<string>();
            targets.add(loc.parts[1]!);
            unresolvedCandidates.set(match[1]!, targets);
          }
        }
      }
      continue;
    }
    if (head.metadata.kind !== "record") {
      const raw: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await fs.bytes(ns.object(loc, head), 2097152),
        ),
      );
      assertDiskFormat(raw);
      // An ordinary old-epoch record keeps its original cleanup semantics. Only a
      // verified plan with this exact pending ticket owns the abort barriers.
      if (head.target.kind === "import" && isFirstImportPlan(head.target)) {
        const journal = importDocumentSchema.safeParse(raw);
        if (
          journal.success &&
          journal.data.plan.id === head.target.key &&
          journal.data.plan.targetSourceKey === ns.sourceKey
        ) {
          if (!exactDocument(await fs.bytes(loc.head, 8192), head)) throw new Error("corrupt");
          for (const item of journal.data.plan.items) claimedItems.add(item.ticket.id);
          for (const [index, item] of journal.data.items.entries()) {
            const ticket = item.publicationTicket;
            if (ticket) claimedItems.add(ticket.id);
            if (
              !journal.data.complete &&
              item.state === "pending" &&
              item.receipt === null &&
              ticket?.target.kind === "record" &&
              ticket.target.expectedRevision === null
            )
              pendingRecords.set(ticket.id, [
                ...(pendingRecords.get(ticket.id) ?? []),
                { ticket, item: journal.data.plan.items[index]! },
              ]);
          }
        }
      }
    }
    result.heads.push(head);
    const record = liveRecord(head);
    if (record) {
      result.totals.committed += record.byteLength;
      result.totals.records++;
      if (head.object) payloads.add(fs.name(ns.object(loc, head)));
    }
    if (await fs.exists(loc.previous)) {
      const previous = parseHead(await fs.bytes(loc.previous, 8192));
      await ns.verify(loc, previous);
      if (previous.object && previous.object !== head.object && previous.metadata.kind === "record")
        retained.add(fs.name(ns.object(loc, previous)));
    }
  }
  // If the last rename was visible at startup its source candidate is already
  // gone. Authenticate the pair and finish the directory barriers even on old
  // layouts without staging intent. An orphan evidence file grants no disposition.
  if (inventory.some((file) => /^quarantine\/[^/]+\.prepublish/.test(file.relative)))
    await checkQuarantineNames(ns);
  for (const file of inventory) {
    const match = /^quarantine\/([0-9a-f-]{36})\.prepublish(-head|\.bin)$/.exec(file.relative);
    if (!match || !(await fs.exists(file.path))) continue;
    const id = match[1]!;
    const headPath = ns.path("quarantine", id + ".prepublish-head");
    if (match[2] === ".bin") {
      if (!(await fs.exists(headPath))) {
        result.problems.push("corrupt");
        unresolvedStages.add(id);
      }
      continue;
    }
    const candidate = canonicalHead(await fs.bytes(headPath, 8192));
    if (
      !candidate.importTag ||
      candidate.receipt.commitId !== id ||
      candidate.target.kind !== "record" ||
      candidate.target.expectedRevision !== null ||
      candidate.metadata.kind !== "record" ||
      candidate.metadata.deleted
    )
      throw new Error("corrupt");
    const object = ns.path("quarantine", id + ".prepublish.bin");
    const abortTag = ns.path("staging", id, "abort-tag.json");
    const aborting = await fs.exists(abortTag);
    if (!aborting || (await fs.exists(object))) await ns.verifyObject(object, candidate);
    // Only a verified journal for this source can explain the retained destination.
    const journalHead = result.heads.find(
      (head) => head.target.kind === "import" && head.target.key === candidate.importTag!.importId,
    );
    if (!journalHead) throw new Error("corrupt");
    const journal = await readImportJournal(ns, journalHead);
    const item = journal.plan.items.find((item) => sameImportValue(item.tag, candidate.importTag));
    if (
      !item ||
      !sameImportValue(item.ticket.target, candidate.target) ||
      !sameImportValue(item.ticket.metadata, candidate.metadata)
    )
      throw new Error("corrupt");
    if (aborting) {
      const index = journal.plan.items.indexOf(item);
      const evidence = journal.items[index]!;
      const attempt = evidence.publicationTicket;
      const loc = await ns.location(candidate.target);
      if (
        journal.complete ||
        evidence.state !== "pending" ||
        evidence.receipt ||
        attempt?.id !== id ||
        !sameImportValue(attempt.target, candidate.target) ||
        !sameImportValue(attempt.metadata, candidate.metadata) ||
        !sameImportValue(candidate, recordCandidate(attempt, item.tag, fs.durability)) ||
        candidate.sha256 !== item.mappedSha256 ||
        candidate.byteLength !== item.byteLength ||
        candidate.object !== candidate.receipt.revision + ".bin" ||
        (await fs.entries(ns.path("staging", id), 4096)).length !== 3 ||
        (await fs.entries(loc.directory, 4096)).some((e) => !e.directory || e.name !== "objects") ||
        (await fs.entries(loc.objects, 4096)).length
      )
        throw new Error("corrupt");
      await fs.syncDirectory(ns.path("quarantine"));
      await fs.syncDirectory(loc.directory);
      await removeAbortedEvidence(ns, object, headPath);
    } else if (
      journal.items.some((item) => item.state === "pending" && item.publicationTicket?.id === id)
    ) {
      await fs.syncDirectory(ns.path("quarantine"));
      await fs.syncDirectory((await ns.location(candidate.target)).directory);
    }
  }
  // A completed process cannot own resumable staging in this new host epoch. Clean only the
  // recognized transient files after validating their identity; never replay their payload.
  for (const entry of stages) {
    if (unresolvedStages.has(entry.name)) continue;
    const targets = unresolvedCandidates.get(entry.name);
    let ownsCandidate = false;
    for (const { ticket, item } of pendingRecords.get(entry.name) ?? []) {
      if (ticket.target.kind !== "record" || !targets?.has(ticket.target.id)) continue;
      const candidate = parseHead(
        await fs.bytes(ns.path("records", ticket.target.id, `head.${entry.name}.tmp`), 8192),
      );
      if (
        candidate.receipt.commitId === ticket.id ||
        sameImportValue(candidate.importTag, item.tag)
      ) {
        ownsCandidate = true;
        break;
      }
      const tag = ns.path("staging", entry.name, "import-tag.json");
      // This optional document supplies positive ownership evidence only.
      // Unavailable bytes cannot claim an unrelated stage.
      const bytes = await fs.bytes(tag, 8192).catch(() => null);
      if (bytes && exactDocument(bytes, { formatVersion: 1, tag: item.tag })) {
        ownsCandidate = true;
        break;
      }
    }
    if (ownsCandidate) continue;
    const intent = ns.path("staging", entry.name, "intent.json");
    if (!(await fs.exists(intent))) {
      const dir = ns.path("staging", entry.name);
      const contents = await fs.entries(dir, 4096);
      if (contents.length) {
        // The first operation in a new journal stage installs its intent. Only
        // its exclusive scratch can exist before that install: no other file
        // in staging, no ticket-specific destination, no published receipt.
        const scratch = contents[0]!;
        if (
          contents.length !== 1 ||
          scratch.directory ||
          !["journal-intent.tmp", "import-record-intent.tmp"].includes(scratch.name) ||
          (scratch.name === "journal-intent.tmp" && claimedItems.has(entry.name)) ||
          scratch.bytes > 8192 ||
          !z.string().uuid().safeParse(entry.name).success ||
          result.heads.some((h) => h.receipt.commitId === entry.name) ||
          inventory.some(
            (f) =>
              !f.relative.startsWith("staging/" + entry.name + "/") &&
              f.relative.includes(entry.name),
          )
        ) {
          result.problems.push("corrupt");
          continue;
        }
        const path = ns.path("staging", entry.name, scratch.name);
        const bytes = await fs.bytes(path, 8192);
        const knownScratch =
          scratch.name === "journal-intent.tmp"
            ? journalIntentScratch(bytes, ns.sourceKey, entry.name, hostEpoch, result.heads)
            : scratch.name === "import-record-intent.tmp" &&
              (await interruptedReserveIntent(ns, entry.name, bytes, hostEpoch, result.heads));
        if (!knownScratch) {
          result.problems.push("corrupt");
          continue;
        }
        await fs.unlink(path);
      }
      await fs.removeEmpty(dir);
      continue;
    }
    const intentBytes = await fs.bytes(intent, 8192);
    const value = JSON.parse(Buffer.from(intentBytes).toString("utf8")) as {
      predecessor?: unknown;
      formatVersion?: unknown;
      ticket?: { owner?: { hostEpoch?: unknown; sourceKey?: unknown } };
    };
    assertDiskFormat(value);
    if (value.ticket?.owner?.sourceKey !== ns.sourceKey) throw new Error("identity-mismatch");
    const checkedTicket = publicationTicketSchema.parse(value.ticket);
    if (
      isFirstImportPlan(checkedTicket.target) &&
      !(await legacyImportReserve(ns, entry.name, value.ticket, checkedTicket))
    ) {
      await recoverJournalStage(ns, entry.name, checkedTicket, intentBytes, result.problems);
      continue;
    }
    if (checkedTicket.target.kind === "import") {
      const payload = ns.path("staging", entry.name, "payload.tmp");
      if (await resolvedImport(ns, entry.name, false)) {
        if (await fs.exists(payload)) await fs.unlink(payload);
        continue;
      }
      // Classify verified heads before touching the only persisted association.
      const loc = await ns.location(checkedTicket.target),
        head = await ns.head(loc);
      if (head) await ns.verify(loc, head);
      const raw = value;
      if (Object.keys(raw).sort().join(",") !== "byteLength,formatVersion,predecessor,ticket")
        throw new Error("corrupt");
      const predecessor =
        raw.predecessor === null ? null : parseHead(Buffer.from(JSON.stringify(raw.predecessor)));
      if (predecessor) await ns.verify(loc, predecessor);
      let matching = false;
      const candidatePath = ns.path("staging", entry.name, "publication.json");
      if (head && (await fs.exists(candidatePath))) {
        const candidate = parseHead(await fs.bytes(candidatePath, 8192));
        if (
          !sameImportValue(candidate.target, checkedTicket.target) ||
          !sameImportValue(candidate.metadata, checkedTicket.metadata)
        )
          throw new Error("identity-mismatch");
        matching = sameImportValue(candidate, head);
      }
      if (
        head &&
        (checkedTicket.target.key.startsWith("nonce/") ||
          checkedTicket.target.key.startsWith("barrier/"))
      ) {
        const bytes = await fs.bytes(ns.object(loc, head), 2097152);
        const document = checkedTicket.target.key.startsWith("nonce/")
          ? parseNonceDocument(bytes)
          : parseBarrierDocument(bytes);
        matching = sameImportValue(document.ticket, checkedTicket);
      }
      if (await fs.exists(payload)) await fs.unlink(payload);
      if (matching) {
        await fs.syncDirectory(loc.directory);
        await persistResolution(ns, entry.name, {
          formatVersion: 1,
          disposition: "committed",
          receipt: head!.receipt,
        });
      } else if (sameImportValue(head, predecessor)) {
        await persistResolution(ns, entry.name, {
          formatVersion: 1,
          disposition: "not-committed",
          receipt: null,
        });
      } else result.problems.push("import-uncertain");
      // Retain bounded metadata association under the existing metadata quota. Never promote payload.tmp.
      continue;
    }
    // Unavailable records still need their original intent/seal evidence. Epoch
    // retirement is not authority to erase an unresolved publication's provenance.
    if (
      checkedTicket.target.kind === "record" &&
      unresolved.has(fs.name((await ns.location(checkedTicket.target)).directory))
    )
      continue;
    if (value.ticket.owner.hostEpoch !== hostEpoch) {
      const pending = pendingRecords.get(entry.name);
      const importedAttempt = pending?.some(({ ticket }) => sameImportValue(ticket, checkedTicket));
      if (importedAttempt && pending?.length !== 1) throw new Error("identity-mismatch");
      if (importedAttempt) {
        if (checkedTicket.id !== entry.name) throw new Error("identity-mismatch");
        const dir = ns.path("staging", entry.name);
        const contents = await fs.entries(dir, 4096);
        if (
          contents.some(
            (e) =>
              e.directory ||
              ![
                "intent.json",
                "payload.tmp",
                "import-tag.json",
                "abort-tag.json",
                "sealed.json",
                "publication.json",
              ].includes(e.name),
          )
        )
          throw new Error("corrupt");
        const { ticket, item } = pending![0]!;
        // The journal binds this reserve. Its installed intent is rename-published.
        // The shared stage sidecars are written in place and confer no cleanup authority.
        if (
          !exactDocument(intentBytes, {
            formatVersion: 1,
            ticket,
            byteLength: item.byteLength,
            predecessor: null,
          })
        )
          throw new Error("corrupt");
        const loc = await ns.location(checkedTicket.target);
        // This stage can be retired only after its published head agrees with
        // the journal. With no stage, a foreign head stays unresolved.
        if (await fs.exists(loc.head)) {
          const bytes = await fs.bytes(loc.head, 8192);
          const published = parseHead(bytes);
          if (
            (published.receipt.commitId === ticket.id ||
              sameImportValue(published.importTag, item.tag)) &&
            !exactDocument(bytes, recordCandidate(ticket, item.tag, fs.durability))
          )
            throw new Error("corrupt");
        }
        if (await fs.exists(ns.path("staging", entry.name, "abort-tag.json")))
          await fs.syncDirectory(ns.path("quarantine"));
        // The previous process might have died just after the candidate unlink
        // or evidence rename. Finish both directory barriers before erasing staging.
        if (
          !(await fs.exists(loc.head)) &&
          (await fs.exists(ns.path("staging", entry.name, "import-tag.json")))
        ) {
          await fs.syncDirectory(loc.directory);
        }
      }
      for (const name of [
        "payload.tmp",
        "sealed.json",
        "import-tag.json",
        ...(importedAttempt ? ["abort-tag.json"] : []),
        "publication.json",
        "intent.json",
      ]) {
        const p = ns.path("staging", entry.name, name);
        try {
          if (await fs.exists(p)) await fs.unlink(p);
        } catch (e) {
          result.problems.push(
            (e as NodeJS.ErrnoException).code === "EACCES" ? "permission" : "cleanup-failed",
          );
          if (importedAttempt) break;
        }
      }
      if ((await fs.entries(ns.path("staging", entry.name), 4096)).length === 0)
        await fs.removeEmpty(ns.path("staging", entry.name));
    }
  }
  for (const file of await ns.inventory()) {
    const name = fs.name(file.path);
    if (payloads.has(name)) continue;
    if (
      /^quarantine\/[0-9a-f-]{36}\.prepublish\.bin$/.test(file.relative) ||
      retained.has(name) ||
      /(?:^|\/)objects\/r_[0-9a-f]{32}\.bin$/.test(file.relative) ||
      file.relative.endsWith("/payload.tmp")
    )
      result.totals.temporary += file.bytes;
    else result.totals.metadata += file.bytes;
  }
  if (
    result.totals.committed > 536870912 ||
    result.totals.records > 256 ||
    result.totals.temporary > 33554432 ||
    result.totals.metadata > 4194304
  )
    result.problems.push("quota");
  return result;
}
export async function garbageCandidates(
  ns: Namespace,
  protectedPaths: ReadonlySet<string>,
): Promise<StorePath[]> {
  const refs = new Set(protectedPaths),
    fs = ns.fs;
  for (const loc of await ns.locations()) {
    for (const p of [loc.head, loc.previous])
      if (await fs.exists(p)) {
        const head = parseHead(await fs.bytes(p, 8192));
        await ns.verify(loc, head);
        if (head.object) refs.add(fs.name(ns.object(loc, head)));
      }
  }
  return (await ns.inventory())
    .filter(
      (file) =>
        /(?:^|\/)objects\/r_[0-9a-f]{32}\.(?:bin|json)$/.test(file.relative) &&
        !refs.has(fs.name(file.path)),
    )
    .map((file) => file.path);
}
