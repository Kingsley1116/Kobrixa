import { expect, it } from "vitest";
import { pendingWhatsNew, WHATS_NEW, type WhatsNewEntry } from "./whats-new.js";

const entries: WhatsNewEntry[] = ["3", "2", "1"].map((version) => ({
  version,
  items: [{ zh: version, en: version }],
}));
const versions = (list: WhatsNewEntry[]) => list.map((entry) => entry.version);

it("shows every entry newer than the last seen version up to the running one", () => {
  expect(versions(pendingWhatsNew(entries, "3", "1"))).toEqual(["3", "2"]);
  expect(versions(pendingWhatsNew(entries, "2", "1"))).toEqual(["2"]);
  expect(versions(pendingWhatsNew(entries, "3", "3"))).toEqual([]);
});

it("shows only the running version without a record or with an unknown record", () => {
  expect(versions(pendingWhatsNew(entries, "3", null))).toEqual(["3"]);
  expect(versions(pendingWhatsNew(entries, "3", "0"))).toEqual(["3", "2", "1"]);
  expect(versions(pendingWhatsNew(entries, "4", null))).toEqual([]);
});

it("keeps the bundled highlights bilingual with one entry per version", () => {
  expect(new Set(WHATS_NEW.map((entry) => entry.version)).size).toBe(WHATS_NEW.length);
  for (const entry of WHATS_NEW)
    for (const item of entry.items) expect(item.zh && item.en).toBeTruthy();
});
