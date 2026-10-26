import { expect, it } from "vitest";
import { createPersistenceActionsClient } from "./persistence-actions.js";
import type { PersistenceRequest } from "./settings.js";
it("does not replay user actions on a lost reply", async () => {
  let count = 0;
  const request = (async () => { count++; throw new Error("lost reply"); }) as PersistenceRequest;
  await expect(createPersistenceActionsClient(request).copyText({ actionRef: "00000000-0000-4000-8000-000000000001", text: "private" })).rejects.toThrow("lost reply");
  expect(count).toBe(1);
});
