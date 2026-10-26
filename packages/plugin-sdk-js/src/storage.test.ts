import { expect, it } from "vitest";
import { createStorageClient, acceptDrainSubmission } from "./storage.js";
import type { PersistenceRequest } from "./settings.js";
it("never begins a replacement to hide a lost commit acknowledgement", async () => {
  const methods: string[] = [];
  const request = (async (m: string) => { methods.push(m); throw new Error("timeout"); }) as PersistenceRequest;
  await expect(createStorageClient(request).commitWrite({ write: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow("timeout");
  expect(methods).toEqual(["storage/commitWrite"]);
});
it("drain result carries submitted/checkpoint-only, never saved", () => {
  expect(acceptDrainSubmission({ status: "submitted", writes: [] })).toEqual({ status: "submitted", writes: [] });
  expect(() => acceptDrainSubmission({ status: "saved", writes: [] })).toThrow();
  expect(() => acceptDrainSubmission({ status: "submitted", writes: [], receipt: "fake" })).toThrow();
});
