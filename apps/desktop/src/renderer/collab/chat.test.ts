import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_LIMITS, type ChatMessage } from "@kobrixa/collab-protocol";
import { CHAT_TRIM_SLACK, ChatController, chatControllerFor } from "./chat.js";
import { createLinkedSessions, type LinkedSession } from "./testing.js";
import { sharedTypes } from "./types.js";

function room(): {
  host: LinkedSession;
  editor: LinkedSession;
  viewer: LinkedSession;
  chats: [ChatController, ChatController, ChatController];
} {
  const { sessions } = createLinkedSessions(["host", "editor", "viewer"]);
  const [host, editor, viewer] = sessions as [LinkedSession, LinkedSession, LinkedSession];
  return {
    host,
    editor,
    viewer,
    chats: [new ChatController(host), new ChatController(editor), new ChatController(viewer)],
  };
}

function message(index: number, participantId = "participant-1"): ChatMessage {
  return { id: `m-${index}`, participantId, name: "User 2", text: `message ${index}`, at: index };
}

describe("ChatController", async () => {
  it("relays editor messages to the host and viewer", async () => {
    const { chats, editor } = room();
    const [hostChat, editorChat, viewerChat] = chats;
    const result = await editorChat.send("  hello\nworld  ");
    expect(result.ok).toBe(true);
    for (const chat of chats) {
      expect(chat.getSnapshot().messages).toEqual([
        expect.objectContaining({
          participantId: editor.connection.participantId,
          name: editor.connection.name,
          text: "hello\nworld",
        }),
      ]);
    }
    expect(hostChat.getSnapshot().canSend).toBe(true);
    expect(viewerChat.getSnapshot().canSend).toBe(false);
  });

  it("does not let viewers send, and drops their raw pushes", async () => {
    const { chats, viewer } = room();
    const [hostChat, editorChat, viewerChat] = chats;
    expect(await viewerChat.send("hi")).toEqual({ ok: false, reason: "read-only" });
    sharedTypes(viewer.doc).chat.push([message(1, viewer.connection.participantId)]);
    expect(hostChat.getSnapshot().messages).toHaveLength(0);
    expect(editorChat.getSnapshot().messages).toHaveLength(0);
  });

  it("enables sending when a viewer is promoted", async () => {
    const { chats, viewer } = room();
    const [, editorChat, viewerChat] = chats;
    viewer.setRole("editor");
    expect(viewerChat.getSnapshot().canSend).toBe(true);
    editorChat.setVisible(true);
    expect((await viewerChat.send("now I can talk")).ok).toBe(true);
    expect(editorChat.getSnapshot().messages.at(-1)?.text).toBe("now I can talk");
  });

  it("ignores invalid and duplicate items", async () => {
    const { chats, editor } = room();
    const chat = sharedTypes(editor.doc).chat as Y.Array<unknown>;
    chat.push([
      "not a message",
      { ...message(1), text: "   " },
      { ...message(2), extra: true },
      { ...message(3), text: "x".repeat(COLLAB_LIMITS.chatMessageLength + 1) },
      { ...message(5), at: Number.MAX_SAFE_INTEGER },
      message(4),
      message(4),
      null,
    ]);
    for (const controller of chats) {
      expect(controller.getSnapshot().messages.map((item) => item.id)).toEqual(["m-4"]);
    }
  });

  it("counts unread messages from others while hidden", async () => {
    const { chats } = room();
    const [hostChat, editorChat] = chats;
    const notified: number[] = [];
    hostChat.subscribe(() => notified.push(hostChat.getSnapshot().unread));

    editorChat.send("one");
    editorChat.send("two");
    hostChat.send("own message");
    expect(hostChat.getSnapshot().unread).toBe(2);
    expect(editorChat.getSnapshot().unread).toBe(1);
    expect(notified.at(-1)).toBe(2);

    hostChat.setVisible(true);
    hostChat.markRead();
    expect(hostChat.getSnapshot().unread).toBe(0);

    hostChat.setVisible(true);
    editorChat.send("three");
    expect(hostChat.getSnapshot().unread).toBe(0);
    hostChat.setVisible(false);
    editorChat.send("four");
    expect(hostChat.getSnapshot().unread).toBe(1);
    hostChat.setVisible(true);
    expect(hostChat.getSnapshot().unread).toBe(0);
  });

  it("treats history present when joining as read", async () => {
    const linked = createLinkedSessions(["host", "editor"]);
    const editorChat = new ChatController(linked.sessions[1]!);
    editorChat.send("before you came");
    const late = linked.join("editor");
    const lateChat = new ChatController(late);
    expect(lateChat.getSnapshot()).toMatchObject({
      unread: 0,
      messages: [{ text: "before you came" }],
    });
  });

  it("keeps snapshots immutable and stable", async () => {
    const { chats } = room();
    const [hostChat, editorChat] = chats;
    const before = hostChat.getSnapshot();
    expect(hostChat.getSnapshot()).toBe(before);
    editorChat.send("hello");
    const after = hostChat.getSnapshot();
    expect(after).not.toBe(before);
    expect(before.messages).toHaveLength(0);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.messages)).toBe(true);
  });

  it("validates text length and emptiness", async () => {
    const { chats } = room();
    const editorChat = chats[1];
    expect(await editorChat.send("   \n ")).toEqual({ ok: false, reason: "empty" });
    expect(await editorChat.send("x".repeat(COLLAB_LIMITS.chatMessageLength + 1))).toEqual({
      ok: false,
      reason: "too-long",
    });
    const padded = ` ${"x".repeat(COLLAB_LIMITS.chatMessageLength)} `;
    expect((await editorChat.send(padded)).ok).toBe(true);
    expect(editorChat.getSnapshot().messages).toHaveLength(1);
  });

  it("lets only the host trim, down to exactly the limit", async () => {
    const { chats, host, editor, viewer } = room();
    const [hostChat, editorChat] = chats;
    hostChat.dispose();
    const fill = COLLAB_LIMITS.chatMessages + CHAT_TRIM_SLACK;
    sharedTypes(editor.doc).chat.push(Array.from({ length: fill }, (_, index) => message(index)));
    expect(sharedTypes(host.doc).chat.length).toBe(fill);

    // Not over the threshold yet: nobody trims.
    const hostAgain = new ChatController(host);
    expect(sharedTypes(host.doc).chat.length).toBe(fill);

    editorChat.send("over the threshold");
    for (const session of [host, editor, viewer]) {
      expect(sharedTypes(session.doc).chat.length).toBe(COLLAB_LIMITS.chatMessages);
    }
    expect(hostAgain.getSnapshot().messages.at(-1)?.text).toBe("over the threshold");
    expect(hostAgain.getSnapshot().messages[0]?.id).toBe(`m-${CHAT_TRIM_SLACK + 1}`);
  });

  it("trims idempotently when sends race with the trim", async () => {
    const { chats, host, editor } = room();
    const [, editorChat] = chats;
    const limit = COLLAB_LIMITS.chatMessages;
    sharedTypes(editor.doc).chat.push(
      Array.from({ length: limit + CHAT_TRIM_SLACK }, (_, index) => message(index)),
    );

    // The editor goes offline, sends while the host trims, then both merge.
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(editor.doc));
    const offlineChat = sharedTypes(offline).chat;
    offlineChat.push([message(10_000), message(10_001)]);
    editorChat.send("live");
    expect(sharedTypes(host.doc).chat.length).toBe(limit);

    Y.applyUpdate(host.doc, Y.encodeStateAsUpdate(offline));
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(host.doc));
    // Two late messages fit within the slack; the host does not trim again.
    expect(sharedTypes(host.doc).chat.length).toBe(limit + 2);
    expect(offlineChat.length).toBe(limit + 2);
    expect(offlineChat.toJSON()).toEqual(sharedTypes(host.doc).chat.toJSON());
  });

  it("stops observing after dispose", async () => {
    const { chats } = room();
    const [hostChat, editorChat] = chats;
    let calls = 0;
    hostChat.subscribe(() => calls++);
    hostChat.dispose();
    editorChat.send("hello");
    expect(calls).toBe(0);
    expect(hostChat.getSnapshot().messages).toHaveLength(0);
    expect(await hostChat.send("x")).toEqual({ ok: false, reason: "read-only" });
  });

  it("disables sending once the session closes", async () => {
    const { chats, editor } = room();
    const editorChat = chats[1];
    editor.close("kicked");
    expect(editorChat.getSnapshot().canSend).toBe(false);
    expect(await editorChat.send("anyone?")).toEqual({ ok: false, reason: "read-only" });
  });

  it("keeps one controller per session so unread state survives remounts", async () => {
    const { sessions } = createLinkedSessions(["host", "editor"]);
    const [host, editor] = sessions as [LinkedSession, LinkedSession];
    const hostChat = chatControllerFor(host);
    expect(chatControllerFor(host)).toBe(hostChat);
    expect(chatControllerFor(editor)).not.toBe(hostChat);
    sharedTypes(editor.doc).chat.push([message(1, editor.connection.participantId)]);
    expect(chatControllerFor(host).getSnapshot().unread).toBe(1);
  });
});

it("lets viewers send through the server without trusting local author or time", async () => {
  const { viewer } = room();
  const calls: unknown[] = [];
  const controller = new ChatController(viewer, {
    sendChat: async (roomId, message) => {
      calls.push({ roomId, message });
      return {
        ok: true,
        value: {
          ...message,
          participantId: viewer.connection.participantId,
          name: "Server name",
          at: 1234,
        },
      };
    },
  });
  expect(controller.getSnapshot().canSend).toBe(true);
  expect(await controller.send("hello", "stable-message-id")).toMatchObject({
    ok: true,
    message: { name: "Server name", at: 1234 },
  });
  expect(calls).toEqual([
    { roomId: viewer.connection.roomId, message: { id: "stable-message-id", text: "hello" } },
  ]);
  expect(sharedTypes(viewer.doc).chat.length).toBe(0);
});
it("keeps incoming messages unread while scrolled up or while the window is hidden", () => {
  const { chats } = room();
  const [host, editor] = chats;
  host.setVisible(true);
  host.setAtBottom(false);
  void editor.send("unread above bottom");
  expect(host.getSnapshot().unread).toBe(1);
  host.markRead();
  expect(host.getSnapshot().unread).toBe(1);
  host.setVisible(false);
  host.setAtBottom(true);
  expect(host.getSnapshot().unread).toBe(1);
  host.setVisible(true);
  expect(host.getSnapshot().unread).toBe(0);
});
