import { describe, expect, it } from "vitest";
import { visibleRemoteEntries, selectRemoteEntries } from "./remote-selection.js";
import { PROJECT_ROOT as ROOT } from "./remote-files.js";
const items = [
  { name: "file10", path: `${ROOT}/file10`, kind: "file" as const },
  { name: "file2", path: `${ROOT}/file2`, kind: "file" as const },
  { name: "robot", path: `${ROOT}/robot`, kind: "directory" as const },
  { name: "SD_Card", path: `${ROOT}/SD_Card`, kind: "directory" as const },
];
describe("EV3 browser selection", () => {
  it("filters only current entries and naturally sorts folders before files", () => {
    expect(visibleRemoteEntries(items, "").map((i) => i.name)).toEqual([
      "robot",
      "SD_Card",
      "file2",
      "file10",
    ]);
    expect(visibleRemoteEntries(items, " FILE").map((i) => i.name)).toEqual(["file2", "file10"]);
  });
  it("supports replace, toggle and reverse ranges without selecting storage roots", () => {
    const entries = visibleRemoteEntries(items, "");
    expect(selectRemoteEntries(entries, [], `${ROOT}/SD_Card`, undefined, "single")).toEqual([]);
    expect(selectRemoteEntries(entries, [], `${ROOT}/robot`, `${ROOT}/file10`, "range")).toEqual([
      `${ROOT}/robot`,
      `${ROOT}/file2`,
      `${ROOT}/file10`,
    ]);
    expect(
      selectRemoteEntries(entries, [`${ROOT}/file2`], `${ROOT}/file2`, undefined, "toggle"),
    ).toEqual([]);
    expect(
      selectRemoteEntries(entries, [`${ROOT}/file2`], `${ROOT}/robot`, undefined, "single"),
    ).toEqual([`${ROOT}/robot`]);
  });
});
