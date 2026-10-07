import {
  COLLAB_LIMITS,
  DOC_KEYS,
  chatMessageSchema,
  collabPathSchema,
  controlStateSchema,
  treeEntrySchema,
  type ChatMessage,
} from "@kobrixa/collab-protocol";
import * as Y from "yjs";
import type { ParticipantRow } from "./store.js";

const utf8 = new TextEncoder();

/** Materialize root types before decoding: Yjs does not encode their constructors. */
export function roomDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap(DOC_KEYS.files);
  doc.getMap(DOC_KEYS.tree);
  doc.getArray(DOC_KEYS.chat);
  doc.getMap(DOC_KEYS.control);
  doc.getMap(DOC_KEYS.meta);
  return doc;
}

function invalid(reason: string): never {
  throw new Error(reason);
}

/**
 * Validate on a disposable document before touching the live document or storage.
 * Pending structs/deletions are forbidden: otherwise a later actor could supply
 * their missing dependency and accidentally authorize an earlier forged update.
 */
export function validateUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  actor: ParticipantRow,
  participants: readonly ParticipantRow[],
): { requests?: string[] } {
  if (update.byteLength > COLLAB_LIMITS.documentBytes) invalid("document update too large");
  const snapshot = Y.encodeStateAsUpdate(doc);
  if (snapshot.byteLength > COLLAB_LIMITS.documentBytes) invalid("document too large");
  const candidate = roomDoc();
  try {
    Y.applyUpdate(candidate, snapshot);
    Y.applyUpdate(candidate, update);
    if (candidate.store.pendingStructs || candidate.store.pendingDs) invalid("incomplete update");
    for (const key of candidate.share.keys()) {
      if (!Object.values(DOC_KEYS).includes(key as (typeof DOC_KEYS)[keyof typeof DOC_KEYS])) {
        invalid("unknown document root");
      }
    }

    const files = candidate.getMap(DOC_KEYS.files);
    const tree = candidate.getMap(DOC_KEYS.tree);
    if (files.size > COLLAB_LIMITS.files) invalid("too many files");
    // The contract limits files, while the tree also carries their directories.
    // In a 200-file project, a directory must not turn the last valid file into
    // an unauthorized update. Bound directory expansion separately by the
    // maximum path length (at most 512 nonempty segments per 1024-character path).
    if (tree.size > COLLAB_LIMITS.files * 512) invalid("too many tree entries");
    let sourceBytes = 0;
    for (const [path, text] of files) {
      if (!collabPathSchema.safeParse(path).success || !(text instanceof Y.Text)) {
        invalid("invalid file");
      }
      const bytes = utf8.encode(text.toString()).byteLength;
      if (bytes > COLLAB_LIMITS.fileBytes) invalid("file too large");
      sourceBytes += bytes;
      if (sourceBytes > COLLAB_LIMITS.roomFileBytes) invalid("room source budget exceeded");
      // Shared files contain plain source text, never embeds or formatting.
      if (
        text
          .toDelta()
          .some(
            (part: { insert?: unknown; attributes?: unknown }) =>
              typeof part.insert !== "string" || part.attributes,
          )
      ) {
        invalid("invalid file content");
      }
    }
    let treeFiles = 0;
    for (const [path, entry] of tree) {
      const parsed = treeEntrySchema.safeParse(entry);
      if (!collabPathSchema.safeParse(path).success || !parsed.success)
        invalid("invalid tree entry");
      if (parsed.data.kind === "file" && ++treeFiles > COLLAB_LIMITS.files)
        invalid("too many files");
    }
    const meta = candidate.getMap(DOC_KEYS.meta);
    for (const [key, value] of meta) {
      if (key === "projectName") {
        if (typeof value !== "string" || !value.trim() || value.length > 120)
          invalid("invalid name");
      } else if (key !== "entry" || !collabPathSchema.safeParse(value).success) {
        invalid("invalid metadata");
      }
    }
    if (!meta.has("projectName")) invalid("missing project name");
    const requests = validateControl(doc, candidate, update, actor, participants);
    validateChat(doc, candidate, actor);
    if (Y.encodeStateAsUpdate(candidate).byteLength > COLLAB_LIMITS.documentBytes)
      invalid("document too large");
    return requests ? { requests } : {};
  } finally {
    candidate.destroy();
  }
}

function validateControl(
  doc: Y.Doc,
  candidate: Y.Doc,
  update: Uint8Array,
  actor: ParticipantRow,
  participants: readonly ParticipantRow[],
): string[] | undefined {
  const before = controlStateSchema.parse(doc.getMap(DOC_KEYS.control).toJSON());
  const after = controlStateSchema.parse(candidate.getMap(DOC_KEYS.control).toJSON());
  const eligible = new Set(
    participants.filter((p) => p.role !== "viewer").map((p) => p.participantId),
  );
  if (after.holder !== null && !eligible.has(after.holder)) invalid("invalid controller");
  if (new Set(after.requests).size !== after.requests.length) invalid("duplicate requests");
  if (after.requests.some((id) => !eligible.has(id))) invalid("invalid request");
  if (actor.role === "host") return;
  const hostId = participants.find((p) => p.role === "host")?.participantId;
  const holderAllowed = (holder: unknown) =>
    holder === before.holder || (before.holder === actor.participantId && holder === hostId);
  if (!holderAllowed(after.holder)) invalid("host-only grant");

  // Inspect new assignments as well as the visible winner. Concurrent Y.Map
  // values may lose the CRDT tie-break; their request intent must still count,
  // and a hidden unauthorized grant must never enter the document history.
  let requested: boolean | undefined;
  let requestClient: number | undefined;
  let requestClock = -1;
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item) || struct.id.clock < Y.getState(doc.store, struct.id.client))
      continue;
    const integrated = Y.getItem(candidate.store, struct.id);
    if (!(integrated instanceof Y.Item) || integrated.parent !== candidate.getMap(DOC_KEYS.control))
      continue;
    const value: unknown = struct.content.getContent().at(-1);
    if (integrated.parentSub === "holder") {
      if (!holderAllowed(value)) invalid("host-only grant");
    } else if (integrated.parentSub === "requests") {
      const requests = controlStateSchema.shape.requests.parse(value);
      if (requests.some((id) => id !== actor.participantId && !before.requests.includes(id))) {
        invalid("cannot request for another participant");
      }
      if (requestClient !== undefined && requestClient !== struct.id.client)
        invalid("ambiguous control requests");
      requestClient = struct.id.client;
      if (struct.id.clock > requestClock) {
        requestClock = struct.id.clock;
        requested = requests.includes(actor.participantId);
      }
    } else invalid("unknown control key");
  }
  // Whole-array Y.Map values race between editors. Preserve all other requests
  // and apply only this actor's explicit latest request/cancel intent.
  const wantsControl = requested ?? before.requests.includes(actor.participantId);
  const requests = wantsControl
    ? before.requests.includes(actor.participantId)
      ? before.requests
      : [...before.requests, actor.participantId]
    : before.requests.filter((id) => id !== actor.participantId);
  return JSON.stringify(requests) === JSON.stringify(after.requests) ? undefined : requests;
}

function validateChat(doc: Y.Doc, candidate: Y.Doc, actor: ParticipantRow): void {
  const before = doc.getArray<ChatMessage>(DOC_KEYS.chat).toArray();
  const after = candidate.getArray<ChatMessage>(DOC_KEYS.chat).toArray();
  // An offline batch can append at most one room history; the server trims after acceptance.
  if (after.length > COLLAB_LIMITS.chatMessages * 2) invalid("too many chat messages");
  const old = new Map(before.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const surviving: string[] = [];
  for (const value of after) {
    const message = chatMessageSchema.parse(value);
    if (Math.abs(message.at) > 8.64e15 || seen.has(message.id)) invalid("invalid chat message");
    seen.add(message.id);
    const previous = old.get(message.id);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(value)) invalid("chat history is immutable");
      surviving.push(message.id);
    } else if (message.participantId !== actor.participantId || message.name !== actor.name) {
      invalid("chat identity mismatch");
    }
  }
  const expected = actor.role === "host" ? before.slice(before.length - surviving.length) : before;
  if (JSON.stringify(expected.map((message) => message.id)) !== JSON.stringify(surviving)) {
    invalid("chat history is append-only");
  }
}
