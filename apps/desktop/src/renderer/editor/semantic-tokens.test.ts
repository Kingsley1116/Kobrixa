import { expect, it, vi } from "vitest";
import type { editor, CancellationToken } from "monaco-editor";
import type { SemanticToken } from "../../shared/language-types.js";
import { legend as semanticLegend } from "./companions/basic-plus/structure.js";
import { LanguageSemanticTokens, encodeSemanticTokens } from "./semantic-tokens.js";

const cancellation = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as CancellationToken;
const read = async (provider: LanguageSemanticTokens, model: editor.ITextModel) =>
  (await provider.provideDocumentSemanticTokens(model, null, cancellation))!.data;
function model(text: string) {
  let version = 1;
  const listeners = new Set<() => void>();
  const dispose = vi.fn();
  return {
    model: {
      uri: { path: "/original.bp" },
      getVersionId: () => version,
      getValue: () => text,
      getLanguageId: () => "bp",
      getLineCount: () => text.split("\n").length,
      getLineMaxColumn: (line: number) => text.split("\n")[line - 1]!.length + 1,
      onDidChangeContent: (listener: () => void) => {
        listeners.add(listener);
        return {
          dispose: () => {
            dispose();
            listeners.delete(listener);
          },
        };
      },
    } as unknown as editor.ITextModel,
    edit() {
      version++;
      for (const listener of listeners) listener();
    },
    dispose,
  };
}
const token: SemanticToken = {
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
  type: "variable",
  modifiers: ["global"],
};

it("encodes UTF-16 deltas and modifiers and rejects overlapping/out-of-range tokens", () => {
  const source = model('name = 1\n"😀" + value').model;
  const second: SemanticToken = {
    ...token,
    type: "parameter",
    modifiers: ["declaration"],
    range: { startLine: 2, startColumn: 8, endLine: 2, endColumn: 13 },
  };
  const invalid: SemanticToken = { ...token, range: { ...token.range, endColumn: 100 } };
  expect([
    ...encodeSemanticTokens([invalid, token, token, second], source, semanticLegend),
  ]).toEqual([
    0,
    0,
    4,
    semanticLegend.tokenTypes.indexOf("variable"),
    8,
    1,
    7,
    5,
    semanticLegend.tokenTypes.indexOf("parameter"),
    1,
  ]);
});

it("translates BOM ranges and ignores snapshots with obsolete document versions", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const source = model("name = 1\nname++");
  const bomToken = { ...token, range: { ...token.range, startColumn: 2, endColumn: 6 } };
  provider.bind(source.model, "main.bp");
  provider.update(
    { "main.bp": [bomToken] },
    { "main.bp": "\uFEFFname = 1\r\nname++" },
    undefined,
    1,
  );
  const valid = await read(provider, source.model);
  expect([...valid]).toEqual([0, 0, 4, semanticLegend.tokenTypes.indexOf("variable"), 8]);
  provider.update(
    { "main.bp": [] },
    { "main.bp": "name = 2\nname++" },
    new Map([[source.model, 0]]),
    1,
  );
  expect(await read(provider, source.model)).toBe(valid);
  provider.dispose();
});

it("reuses unchanged encoded tokens and verifies accepted versions without reading text", () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const source = model("name = 1");
  const read = vi.spyOn(source.model, "getValue");
  const columns = vi.spyOn(source.model, "getLineMaxColumn");
  provider.bind(source.model, "main.bp");
  const tokens = { "main.bp": [token] };
  provider.update(tokens, { "main.bp": "name = 1" }, new Map([[source.model, 1]]), 1);
  columns.mockClear();
  provider.update(tokens, { "main.bp": "name = 1" }, new Map([[source.model, 1]]), 1);
  expect(read).not.toHaveBeenCalled();
  expect(columns).not.toHaveBeenCalled();
  provider.dispose();
});

it("clears obsolete colors when the accepted result cannot load a source", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const source = model("name = 1");
  provider.bind(source.model, "main.bp");
  provider.update({ "main.bp": [token] }, undefined, undefined, 1);
  provider.update({}, {}, new Map(), 1);
  expect(await read(provider, source.model)).toHaveLength(0);
  provider.dispose();
});

it("does not publish a snapshot when an inactive dependency differs", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const active = model("name = 1"),
    dependency = model("name = 2");
  provider.bind(active.model, "main.bp");
  provider.bind(dependency.model, "helper.bpm");
  provider.update({ "main.bp": [token], "helper.bpm": [token] }, undefined, undefined, 1);
  const valid = await read(provider, active.model);
  provider.update(
    { "main.bp": [] },
    { "main.bp": "name = 1", "helper.bpm": "name = 3" },
    new Map([
      [active.model, 1],
      [dependency.model, 0],
    ]),
    1,
  );
  expect(await read(provider, active.model)).toBe(valid);
  provider.dispose();
});

it("keeps untouched models and waits for fresh tokens without clearing the edited document", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const one = model("name = 1"),
    two = model("name = 2");
  provider.bind(one.model, "one.bp");
  provider.bind(two.model, "two.bp");
  const changed = vi.fn();
  provider.onDidChange(changed);
  provider.update({ "one.bp": [token], "two.bp": [token] }, undefined, undefined, 1);
  const untouched = await read(provider, two.model);
  one.edit();
  const resolved = vi.fn();
  const pending = read(provider, one.model).then(resolved);
  await Promise.resolve();
  expect(resolved).not.toHaveBeenCalled();
  expect(await read(provider, two.model)).toBe(untouched);
  expect(changed).toHaveBeenCalledTimes(1);
  provider.update({ "one.bp": [token], "two.bp": [token] }, undefined, undefined, 1);
  await pending;
  expect(resolved).toHaveBeenCalledWith(untouched);
  expect(changed).toHaveBeenCalledTimes(1);
  provider.dispose();
});

it("rejects a pending request if its version changes, rather than returning newer offsets", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const source = model("name = 1");
  provider.bind(source.model, "main.bp");
  provider.update({ "main.bp": [token] }, undefined, undefined, 1);
  source.edit();
  const obsolete = expect(read(provider, source.model)).rejects.toThrow("busy");
  source.edit();
  await obsolete;
  const latest = read(provider, source.model);
  provider.update({ "main.bp": [token] }, undefined, undefined, 1);
  expect(await latest).toHaveLength(5);
  provider.dispose();
});

it("falls back only for edited documents after failure and cleans up pending requests", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const one = model("name = 1"),
    two = model("name = 2");
  provider.bind(one.model, "one.bp");
  provider.bind(two.model, "two.bp");
  provider.update({ "one.bp": [token], "two.bp": [token] }, undefined, undefined, 1);
  one.edit();
  const pending = read(provider, one.model);
  provider.fail();
  expect(await pending).toHaveLength(0);
  expect(await read(provider, two.model)).toHaveLength(5);
  one.edit();
  const removed = expect(read(provider, one.model)).rejects.toThrow("busy");
  provider.unbind(one.model);
  await removed;
  provider.dispose();
  expect(one.dispose).toHaveBeenCalledOnce();
  expect(two.dispose).toHaveBeenCalledOnce();
});

it("uses explicit file bindings after rename and drops removed models and canceled requests", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1);
  const source = model("name = 1");
  provider.bind(source.model, "old.bp");
  provider.update({ "old.bp": [token] }, undefined, undefined, 1);
  provider.bind(source.model, "new.bp");
  expect(await read(provider, source.model)).toHaveLength(0);
  provider.update({ "old.bp": [token] }, undefined, undefined, 1);
  expect(await read(provider, source.model)).toHaveLength(0);
  provider.update({ "new.bp": [token] }, undefined, undefined, 1);
  expect(await read(provider, source.model)).toHaveLength(5);
  expect(
    provider.provideDocumentSemanticTokens(source.model, null, {
      isCancellationRequested: true,
    } as CancellationToken),
  ).toBeNull();
  provider.unbind(source.model);
  expect(await read(provider, source.model)).toHaveLength(0);
  provider.dispose();
});

it("uses the selected legend rather than Basic Plus token ordinals", () => {
  const source = model("name = 1").model;
  const legend = { tokenTypes: ["caseIdentifier", "variable"], tokenModifiers: ["mutable"] };
  expect([
    ...encodeSemanticTokens(
      [
        {
          range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
          type: "caseIdentifier",
          modifiers: ["mutable"],
        },
      ],
      source,
      legend,
    ),
  ]).toEqual([0, 0, 4, 0, 1]);
});

it("ignores an older epoch even when the model version still matches", async () => {
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 3);
  const source = model("name = 1");
  provider.bind(source.model, "main.bp");
  provider.update({ "main.bp": [token] }, undefined, undefined, 3);
  const accepted = await read(provider, source.model);
  provider.update({ "main.bp": [] }, undefined, undefined, 1);
  expect(await read(provider, source.model)).toBe(accepted);
  provider.dispose();
});

it("drops painted and pending tokens immediately when its route is revoked", async () => {
  let current = true;
  const provider = new LanguageSemanticTokens(semanticLegend, "bp", 1, () => current);
  const source = model("name = 1");
  const changed = vi.fn();
  provider.onDidChange(changed);
  provider.bind(source.model, "main.bp");
  provider.update({ "main.bp": [token] }, undefined, undefined, 1);
  expect(await read(provider, source.model)).toHaveLength(5);
  source.edit();
  const pending = expect(read(provider, source.model)).rejects.toThrow("busy");
  current = false;
  provider.unbind(source.model);
  await pending;
  expect(await read(provider, source.model)).toHaveLength(0);
  expect(changed).toHaveBeenCalledTimes(2);
  provider.dispose();
});
