import { describe, expect, it, vi } from "vitest";
import { createLinkedSessions, type LinkedSession } from "./testing.js";
import { DeviceControl, deviceControlNotice } from "./device-control.js";
import { sharedTypes } from "./types.js";

/** Mirrors the server's room initialization: the host holds control. */
function room() {
  const linked = createLinkedSessions(["host", "editor", "viewer"]);
  const [host, editor, viewer] = linked.sessions as [LinkedSession, LinkedSession, LinkedSession];
  host.doc.transact(() => {
    const control = sharedTypes(host.doc).control;
    control.set("holder", host.connection.participantId);
    control.set("requests", []);
  });
  return {
    linked,
    host,
    editor,
    viewer,
    hostControl: new DeviceControl(host),
    editorControl: new DeviceControl(editor),
    viewerControl: new DeviceControl(viewer),
  };
}

describe("DeviceControl", () => {
  it("lets an editor request, receive and release control", () => {
    const { host, editor, hostControl, editorControl } = room();
    expect(hostControl.getSnapshot()).toMatchObject({
      holder: host.connection.participantId,
      holderName: "User 1",
      isHolder: true,
      isHost: true,
      canRequest: false,
    });
    expect(editorControl.getSnapshot()).toMatchObject({
      isHolder: false,
      isHost: false,
      canRequest: true,
      holderName: "User 1",
    });

    const listener = vi.fn();
    hostControl.subscribe(listener);
    editorControl.request();
    expect(listener).toHaveBeenCalled();
    expect(hostControl.getSnapshot().requests).toEqual([
      { participantId: editor.connection.participantId, name: "User 2" },
    ]);
    expect(editorControl.getSnapshot()).toMatchObject({ requested: true, canRequest: false });

    hostControl.grant(editor.connection.participantId);
    expect(editorControl.getSnapshot()).toMatchObject({ isHolder: true, holderName: "User 2" });
    expect(hostControl.getSnapshot()).toMatchObject({ isHolder: false, requests: [] });
    expect(editorControl.getSnapshot().requested).toBe(false);

    editorControl.release();
    expect(hostControl.getSnapshot().isHolder).toBe(true);
    expect(editorControl.getSnapshot()).toMatchObject({ isHolder: false, canRequest: true });
  });

  it("supports cancelling a request and host take-back", () => {
    const { editor, hostControl, editorControl } = room();
    editorControl.request();
    editorControl.cancelRequest();
    expect(hostControl.getSnapshot().requests).toEqual([]);
    hostControl.grant(editor.connection.participantId);
    hostControl.reclaim();
    expect(hostControl.getSnapshot().isHolder).toBe(true);
    expect(editorControl.getSnapshot().isHolder).toBe(false);
  });

  it("lets the host decline a request and tells the requester", () => {
    const { editor, hostControl, editorControl } = room();
    editorControl.request();
    expect(editorControl.getSnapshot()).toMatchObject({ requested: true, declined: false });
    // Editors cannot decline.
    editorControl.decline(editor.connection.participantId);
    expect(hostControl.getSnapshot().requests).toHaveLength(1);

    hostControl.decline(editor.connection.participantId);
    expect(hostControl.getSnapshot()).toMatchObject({ isHolder: true, requests: [] });
    // The declined request is not reasserted.
    expect(sharedTypes(editor.doc).control.get("requests")).toEqual([]);
    expect(editorControl.getSnapshot()).toMatchObject({
      requested: false,
      declined: true,
      canRequest: true,
    });
    editorControl.dismissDeclined();
    expect(editorControl.getSnapshot().declined).toBe(false);

    // A new request after a decline is shown to the host again.
    hostControl.decline(editor.connection.participantId);
    editorControl.request();
    hostControl.decline(editor.connection.participantId);
    editorControl.request();
    expect(editorControl.getSnapshot()).toMatchObject({ requested: true, declined: false });
    expect(hostControl.getSnapshot().requests).toEqual([
      { participantId: editor.connection.participantId, name: "User 2" },
    ]);
  });

  it("hides a declined request locally when the server cannot decline", () => {
    const { host, editor, hostControl, editorControl } = room();
    const spy = vi
      .spyOn(host as Required<LinkedSession>, "declineControlRequest")
      .mockReturnValue(true);
    editorControl.request();
    hostControl.decline(editor.connection.participantId);
    expect(spy).toHaveBeenCalledWith(editor.connection.participantId);
    expect(hostControl.getSnapshot().requests).toEqual([]);
    expect(editorControl.getSnapshot()).toMatchObject({ requested: true, declined: false });
    // Once the requester cancels and asks again, the host sees the new request.
    editorControl.cancelRequest();
    editorControl.request();
    expect(hostControl.getSnapshot().requests).toHaveLength(1);

    // A locally hidden request reappears after the host reconnects.
    hostControl.decline(editor.connection.participantId);
    expect(hostControl.getSnapshot().requests).toEqual([]);
    // The fake session's internal snapshot update simulates a resync.
    const resync = host as LinkedSession & { update(patch: { synced: boolean }): void };
    resync.update({ synced: false });
    resync.update({ synced: true });
    expect(hostControl.getSnapshot().requests).toHaveLength(1);
  });

  it("keeps showing a request when the decline could not be sent", () => {
    const { host, editor, hostControl, editorControl } = room();
    vi.spyOn(host as Required<LinkedSession>, "declineControlRequest").mockReturnValue(false);
    editorControl.request();
    hostControl.decline(editor.connection.participantId);
    expect(hostControl.getSnapshot().requests).toHaveLength(1);
    expect(editorControl.getSnapshot()).toMatchObject({ requested: true, declined: false });
  });

  it("ignores grant and reclaim from non-hosts", () => {
    const { editor, hostControl, editorControl } = room();
    editorControl.grant(editor.connection.participantId);
    editorControl.reclaim();
    expect(hostControl.getSnapshot().isHolder).toBe(true);
  });

  it("does not let viewers request control", () => {
    const { viewer, hostControl, viewerControl } = room();
    expect(viewerControl.getSnapshot().canRequest).toBe(false);
    viewerControl.request();
    // Even a forced local write is dropped by the server relay.
    sharedTypes(viewer.doc).control.set("requests", [viewer.connection.participantId]);
    expect(hostControl.getSnapshot().requests).toEqual([]);
  });

  it("lets the host reclaim control from an offline holder", () => {
    const { editor, hostControl, editorControl } = room();
    hostControl.grant(editor.connection.participantId);
    expect(hostControl.getSnapshot().holderOnline).toBe(true);
    editor.close("left");
    expect(hostControl.getSnapshot()).toMatchObject({ isHolder: false, holderOnline: false });
    hostControl.reclaim();
    expect(hostControl.getSnapshot().isHolder).toBe(true);
    editorControl.dispose();
  });

  it("treats a missing or invalid holder as the host and ignores garbage", () => {
    const { host, hostControl, editorControl } = room();
    const control = sharedTypes(host.doc).control;
    control.set("holder", null);
    expect(hostControl.getSnapshot().isHolder).toBe(true);
    expect(editorControl.getSnapshot().holderName).toBe("User 1");
    control.set("holder", "../bad id");
    control.set("requests", "nope");
    expect(hostControl.getSnapshot()).toMatchObject({ isHolder: true, requests: [] });
    expect(editorControl.getSnapshot().isHolder).toBe(false);
  });

  it("falls back to the host when the holder is demoted to viewer", () => {
    const { editor, hostControl, editorControl } = room();
    hostControl.grant(editor.connection.participantId);
    editor.setRole("viewer");
    expect(editorControl.getSnapshot().isHolder).toBe(false);
    expect(hostControl.getSnapshot().isHolder).toBe(true);
  });

  it("re-adds a request dropped by a concurrent write", () => {
    const { host, editor, hostControl, editorControl } = room();
    editorControl.request();
    // A concurrent last-writer-wins update from another requester overwrites the list.
    sharedTypes(host.doc).control.set("requests", []);
    expect(hostControl.getSnapshot().requests).toEqual([
      { participantId: editor.connection.participantId, name: "User 2" },
    ]);
    editorControl.cancelRequest();
    sharedTypes(host.doc).control.set("requests", []);
    expect(hostControl.getSnapshot().requests).toEqual([]);
  });

  it("denies control during reconnect and after the room closes", () => {
    const { host, editor, hostControl, editorControl } = room();
    const original = host.getSnapshot();
    vi.spyOn(host, "getSnapshot").mockReturnValue({ ...original, status: "reconnecting" });
    sharedTypes(host.doc).control.set("requests", []);
    expect(hostControl.getSnapshot()).toMatchObject({ isHolder: false, holderOnline: false });
    hostControl.grant(editor.connection.participantId);
    expect(editorControl.getSnapshot().isHolder).toBe(false);
    vi.mocked(host.getSnapshot).mockRestore();
    host.close("room-closed");
    expect(hostControl.getSnapshot().isHolder).toBe(false);
    editor.close("room-closed");
    expect(editorControl.getSnapshot().canRequest).toBe(false);
  });

  it("never grants control to a viewer, unknown member or offline editor", () => {
    const { editor, viewer, hostControl } = room();
    for (const participantId of [viewer.connection.participantId, "unknown-participant"])
      hostControl.grant(participantId);
    expect(hostControl.getSnapshot().isHolder).toBe(true);
    editor.close("left");
    hostControl.grant(editor.connection.participantId);
    expect(hostControl.getSnapshot().isHolder).toBe(true);
  });

  it("formats the holder notice", () => {
    expect(deviceControlNotice("en", "Ada")).toBe("Device control is held by Ada");
    expect(deviceControlNotice("zh-TW", "Ada")).toBe("裝置控制權目前由 Ada 持有");
    expect(deviceControlNotice("en", null)).toBe("Device control is held by another collaborator");
  });
});
