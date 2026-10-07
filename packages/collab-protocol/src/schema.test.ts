import { describe, expect, it } from "vitest";
import {
  collabPathSchema,
  COLLAB_ROUTES,
  inviteCodeSchema,
  noticeSchema,
  participantColor,
  presenceStateSchema,
} from "./index.js";

describe("collab protocol", () => {
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

  it("builds routes and cycles colors", () => {
    expect(COLLAB_ROUTES.socket("room")).toBe("/rooms/room/ws");
    expect(participantColor(0)).toBe(participantColor(8));
  });
});
