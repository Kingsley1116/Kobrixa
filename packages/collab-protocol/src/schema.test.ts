import { describe, expect, it } from "vitest";
import {
  collabPathSchema,
  createRoomRequestSchema,
  joinRequestSchema,
  COLLAB_LIMITS,
  displayNameSchema,
  COLLAB_ROUTES,
  controlCommandSchema,
  inviteCodeSchema,
  MESSAGE_TYPE,
  noticeSchema,
  participantColor,
  presenceStateSchema,
} from "./index.js";

describe("collab protocol", () => {
  it("accepts optional passwords without trimming and rejects oversized passwords", () => {
    const create = { name: "Host", projectName: "Robot" };
    const join = { name: "Guest", inviteCode: "ABCD-EFGH-JK23" };
    for (const [schema, body] of [
      [createRoomRequestSchema, create],
      [joinRequestSchema, join],
    ] as const) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.parse({ ...body, password: " A 密碼 " }).password).toBe(" A 密碼 ");
      expect(schema.parse({ ...body, password: "" }).password).toBe("");
      expect(
        schema.safeParse({ ...body, password: "x".repeat(COLLAB_LIMITS.roomPasswordLength + 1) })
          .success,
      ).toBe(false);
      expect(schema.safeParse({ ...body, password: 1234 }).success).toBe(false);
    }
  });
  it("accepts only workspace-relative paths", () => {
    expect(collabPathSchema.safeParse("src/main.bp").success).toBe(true);
    for (const bad of ["/abs.bp", "../up.bp", "a//b.bp", "a\\b.bp", "./a.bp"])
      expect(collabPathSchema.safeParse(bad).success).toBe(false);
  });

  it("validates invite codes without ambiguous characters", () => {
    expect(inviteCodeSchema.safeParse("ABCD-EFGH-JK23").success).toBe(true);
    expect(inviteCodeSchema.safeParse("ABCD-EFGH-JKL0").success).toBe(false);
    expect(inviteCodeSchema.safeParse("abcd-efgh-jkmn").success).toBe(false);
  });

  it("rejects control and bidi characters in display names", () => {
    expect(displayNameSchema.safeParse("小明 Ada").success).toBe(true);
    for (const bad of ["a\u0007b", "a\u0085b", "evil\u202Etxt", "x\u200By"])
      expect(displayNameSchema.safeParse(bad).success).toBe(false);
  });

  it("parses notices and presence", () => {
    expect(noticeSchema.parse({ type: "role", role: "viewer" })).toEqual({
      type: "role",
      role: "viewer",
    });
    expect(
      presenceStateSchema.safeParse({
        participantId: "abcdefgh",
        name: "Ada",
        color: "#3e63dd",
        role: "editor",
        file: "main.bp",
      }).success,
    ).toBe(true);
  });

  it("parses device-control commands and the decline notice", () => {
    expect(controlCommandSchema.parse({ type: "decline", participantId: "abcdefgh" })).toEqual({
      type: "decline",
      participantId: "abcdefgh",
    });
    for (const bad of [
      { type: "decline" },
      { type: "decline", participantId: "../x" },
      { type: "decline", participantId: "abcdefgh", extra: true },
      { type: "grant", participantId: "abcdefgh" },
    ])
      expect(controlCommandSchema.safeParse(bad).success).toBe(false);
    expect(noticeSchema.parse({ type: "control-declined" })).toEqual({ type: "control-declined" });
    expect(MESSAGE_TYPE.control).toBe(3);
  });

  it("builds routes and cycles colors", () => {
    expect(COLLAB_ROUTES.socket("room")).toBe("/rooms/room/ws");
    expect(participantColor(0)).toBe(participantColor(8));
  });
});
