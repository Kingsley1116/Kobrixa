import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { COLLAB_LIMITS, DOC_KEYS } from "@kobrixa/collab-protocol";
import { roomDoc, validateUpdate } from "./validate.js";
import type { ParticipantRow } from "./store.js";

const host: ParticipantRow = {
  participantId: "host-0001",
  name: "Host",
  role: "host",
  revoked: false,
  joinedAt: 0,
};
const guest: ParticipantRow = {
  participantId: "guest-0001",
  name: "Guest",
  role: "editor",
  revoked: false,
  joinedAt: 1,
};
const viewer: ParticipantRow = {
  participantId: "viewer-0001",
  name: "Viewer",
  role: "viewer",
  revoked: false,
  joinedAt: 2,
};
const participants = [host, guest, viewer];
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs) doc.destroy();
  docs.length = 0;
});

function fixture() {
  const server = roomDoc();
  server.getMap(DOC_KEYS.meta).set("projectName", "Robot");
  server.getMap(DOC_KEYS.control).set("holder", host.participantId);
  server.getMap(DOC_KEYS.control).set("requests", []);
  const client = roomDoc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  docs.push(server, client);
  const update = () => Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
  return {
    server,
    client,
    update,
    validate: (actor = guest) => validateUpdate(server, update(), actor, participants),
  };
}

function message(participant = guest) {
  return {
    id: "message-1",
    participantId: participant.participantId,
    name: participant.name,
    text: "Hello",
    at: Date.now(),
  };
}

describe("room update validation", () => {
  test("valid edits leave the authoritative document untouched until acceptance", () => {
    const { server, client, validate } = fixture();
    client.getMap(DOC_KEYS.files).set("main.bas", new Y.Text("PRINT 1"));
    expect(validate()).toEqual({});
    expect(server.getMap(DOC_KEYS.files).size).toBe(0);
  });

  test.each(["../escape.bas", "/absolute.bas", "nested/../escape.bas", "nested\\escape.bas"])(
    "rejects unsafe file path %s",
    (path) => {
      const { client, validate } = fixture();
      client.getMap(DOC_KEYS.files).set(path, new Y.Text("PRINT 1"));
      expect(() => validate()).toThrow("invalid file");
    },
  );

  test("enforces encoded file bytes and plain text types", () => {
    const oversized = fixture();
    oversized.client
      .getMap(DOC_KEYS.files)
      .set("main.bas", new Y.Text("漢".repeat(Math.ceil(COLLAB_LIMITS.fileBytes / 3))));
    expect(() => oversized.validate()).toThrow("file too large");
    const wrongType = fixture();
    wrongType.client.getMap(DOC_KEYS.files).set("main.bas", "string instead of Y.Text");
    expect(() => wrongType.validate()).toThrow("invalid file");
    const rich = fixture();
    const text = new Y.Text();
    rich.client.getMap(DOC_KEYS.files).set("main.bas", text);
    text.insertEmbed(0, { data: "not source code" });
    expect(() => rich.validate()).toThrow("invalid file content");
  });

  test("rejects excess files, invalid tree entries, and unknown roots", () => {
    const tooMany = fixture();
    for (let i = 0; i <= COLLAB_LIMITS.files; i++)
      tooMany.client.getMap(DOC_KEYS.files).set(`${i}.bas`, new Y.Text());
    expect(() => tooMany.validate()).toThrow("too many files");
    const tree = fixture();
    tree.client.getMap(DOC_KEYS.tree).set("main.bas", { kind: "symlink", target: "/etc/passwd" });
    expect(() => tree.validate()).toThrow("invalid tree entry");
    const root = fixture();
    root.client.getMap("other").set("x", "y");
    expect(() => root.validate()).toThrow("unknown document root");
  });

  test("rejects incomplete updates instead of queuing a forged change for a later actor", () => {
    const { server, client } = fixture();
    const updates: Uint8Array[] = [];
    client.on("update", (update: Uint8Array) => updates.push(update));
    client.getMap(DOC_KEYS.files).set("main.bas", new Y.Text("First"));
    client.getMap<Y.Text>(DOC_KEYS.files).get("main.bas")!.insert(0, "Second");
    expect(() => validateUpdate(server, updates[1]!, guest, participants)).toThrow(
      "incomplete update",
    );
  });

  test("ordinary file edits preserve control request order", () => {
    const { server, client, validate } = fixture();
    server.getMap(DOC_KEYS.control).set("requests", [guest.participantId, host.participantId]);
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    client.getMap(DOC_KEYS.files).set("main.bas", new Y.Text("PRINT 1"));
    expect(validate()).toEqual({});
  });

  test("rejects guest grants, forged requests, and even host grants to viewers", () => {
    const grant = fixture();
    grant.client.getMap(DOC_KEYS.control).set("holder", guest.participantId);
    expect(() => grant.validate()).toThrow("host-only grant");
    const request = fixture();
    request.client.getMap(DOC_KEYS.control).set("requests", [host.participantId]);
    expect(() => request.validate()).toThrow("cannot request for another participant");
    const invalid = fixture();
    invalid.client.getMap(DOC_KEYS.control).set("holder", viewer.participantId);
    expect(() => invalid.validate(host)).toThrow("invalid controller");
  });

  test("rejects spoofed chat identities and timestamps outside the Date range", () => {
    const spoof = fixture();
    spoof.client.getArray(DOC_KEYS.chat).push([message(host)]);
    expect(() => spoof.validate()).toThrow("chat identity mismatch");
    const time = fixture();
    time.client.getArray(DOC_KEYS.chat).push([{ ...message(), at: Number.MAX_SAFE_INTEGER }]);
    expect(() => time.validate()).toThrow("invalid chat message");
  });

  test("rejects deleting or rewriting another participant's chat history", () => {
    const { server, client, validate } = fixture();
    server.getArray(DOC_KEYS.chat).push([message(host)]);
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    client.getArray(DOC_KEYS.chat).delete(0, 1);
    expect(() => validate()).toThrow("chat history is append-only");
    client.getArray(DOC_KEYS.chat).push([{ ...message(host), text: "Altered" }]);
    expect(() => validate()).toThrow("chat history is immutable");
  });
});
