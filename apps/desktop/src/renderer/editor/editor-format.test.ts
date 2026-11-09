import { expect, it, vi } from "vitest";
import type { LanguageStatus } from "../../shared/language-services.js";
import { saveSnapshot } from "../workspace/save-coordinator.js";
import { formatSourceForSave } from "./editor-format.js";

vi.mock("monaco-editor", () => ({}));

const status: LanguageStatus = {
  epoch: 1,
  conflicts: [],
  availability: {
    kind: "available",
    binding: {
      epoch: 1,
      pluginId: "kobrixa.basic-plus",
      sourceKey: "builtin:kobrixa.basic-plus",
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: ["analysis", "documentFormatting"],
      frontend: {
        language: "bp",
        entryExtensions: ["bp"],
        sourceExtensions: ["bp", "bpi", "bpm"],
        ir: { min: 1, max: 1 },
      },
    },
  },
};
const content = "If True\nLCD.Clear()\nEndIf";

it.each([1, 2])(
  "saves original content when inactive workspace status lookup %i rejects",
  async (lookup) => {
    const getStatus = vi.fn(async () => status);
    if (lookup === 2) getStatus.mockResolvedValueOnce(status);
    getStatus.mockRejectedValueOnce(new Error("Language status unavailable"));
    const write = vi.fn(async () => undefined);
    const commit = vi.fn();
    const apply = vi.fn();
    const retainDraft = vi.fn(async () => undefined);
    await expect(
      saveSnapshot({
        read: () => ({ content, saved: "" }),
        format: (source) => formatSourceForSave("main.bp", source, 2, getStatus, () => true),
        apply,
        write,
        commit,
        retainDraft,
      }),
    ).resolves.toBeUndefined();
    expect(getStatus).toHaveBeenCalledTimes(lookup);
    expect(write).toHaveBeenCalledExactlyOnceWith(content);
    expect(commit).toHaveBeenCalledExactlyOnceWith(content);
    expect(apply).not.toHaveBeenCalled();
    expect(retainDraft).toHaveBeenCalledExactlyOnceWith(undefined);
  },
);

it("formats a current save snapshot and rejects formatting after its epoch or document changes", async () => {
  await expect(
    formatSourceForSave(
      "main.bp",
      content,
      2,
      () => status,
      () => true,
    ),
  ).resolves.toBe("If True\n  LCD.Clear()\nEndIf\n");
  const getStatus = vi
    .fn()
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ ...status, epoch: 2 });
  await expect(formatSourceForSave("main.bp", content, 2, getStatus, () => true)).resolves.toBe(
    content,
  );
  await expect(
    formatSourceForSave(
      "main.bp",
      content,
      2,
      () => status,
      () => false,
    ),
  ).resolves.toBe(content);
});
