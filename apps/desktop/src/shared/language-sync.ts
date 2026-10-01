import type {
  BasicPlusProjectAnalysis,
  BasicPlusSymbolIndex,
  BasicPlusSemanticToken,
  BasicPlusOccurrence,
} from "@kobrixa/basic-plus";

// Large token/occurrence arrays otherwise clone hundreds of thousands of nested
// range objects across both worker and Electron IPC boundaries.
interface TokenWire {
  data: Uint32Array;
  types: BasicPlusSemanticToken["type"][];
  modifiers: BasicPlusSemanticToken["modifiers"][];
}
interface OccurrenceWire {
  data: Uint32Array;
  strings: string[];
}
function dictionary<T>() {
  const values: T[] = [],
    ids = new Map<T, number>();
  return {
    values,
    id(value: T) {
      let id = ids.get(value);
      if (id === undefined) {
        id = values.length;
        values.push(value);
        ids.set(value, id);
      }
      return id;
    },
  };
}
function packTokens(tokens: BasicPlusSemanticToken[]): TokenWire {
  const types = dictionary<BasicPlusSemanticToken["type"]>(),
    modifiers = dictionary<string>();
  const data = new Uint32Array(tokens.length * 6);
  tokens.forEach((token, i) => {
    const r = token.range;
    const offset = i * 6;
    data[offset] = r.startLine;
    data[offset + 1] = r.startColumn;
    data[offset + 2] = r.endLine;
    data[offset + 3] = r.endColumn;
    data[offset + 4] = types.id(token.type);
    data[offset + 5] = modifiers.id(JSON.stringify(token.modifiers));
  });
  return {
    data,
    types: types.values,
    modifiers: modifiers.values.map(
      (value) => JSON.parse(value) as BasicPlusSemanticToken["modifiers"],
    ),
  };
}
function unpackTokens(wire: TokenWire): BasicPlusSemanticToken[] {
  const result: BasicPlusSemanticToken[] = [];
  const data = wire.data;
  for (let i = 0; i < data.length; i += 6)
    result.push({
      range: {
        startLine: data[i]!,
        startColumn: data[i + 1]!,
        endLine: data[i + 2]!,
        endColumn: data[i + 3]!,
      },
      type: wire.types[data[i + 4]!]!,
      modifiers: wire.modifiers[data[i + 5]!]!,
    });
  return result;
}
function packOccurrences(occurrences: BasicPlusOccurrence[]): OccurrenceWire {
  const strings = dictionary<string>();
  const data = new Uint32Array(occurrences.length * 8);
  occurrences.forEach((item, i) => {
    const r = item.range;
    const offset = i * 8;
    data[offset] = r.startLine;
    data[offset + 1] = r.startColumn;
    data[offset + 2] = r.endLine;
    data[offset + 3] = r.endColumn;
    data[offset + 4] = strings.id(item.file);
    data[offset + 5] = strings.id(item.context);
    data[offset + 6] = strings.id(item.symbolId);
    data[offset + 7] = Number(item.declaration);
  });
  return { data, strings: strings.values };
}
function unpackOccurrences(wire: OccurrenceWire): BasicPlusOccurrence[] {
  const result: BasicPlusOccurrence[] = [];
  const data = wire.data;
  for (let i = 0; i < data.length; i += 8)
    result.push({
      range: {
        startLine: data[i]!,
        startColumn: data[i + 1]!,
        endLine: data[i + 2]!,
        endColumn: data[i + 3]!,
      },
      file: wire.strings[data[i + 4]!]!,
      context: wire.strings[data[i + 5]!]!,
      symbolId: wire.strings[data[i + 6]!]!,
      declaration: Boolean(data[i + 7]),
    });
  return result;
}
function mapPatch<T, U>(patch: RecordPatch<T>, convert: (value: T) => U): RecordPatch<U> {
  return {
    set: Object.fromEntries(Object.entries(patch.set).map(([key, value]) => [key, convert(value)])),
    removed: patch.removed,
  };
}

export interface RecordPatch<T> {
  set: Record<string, T>;
  removed: string[];
}
export interface LanguageSyncRequest {
  session: string;
  revision: number;
  /** null replaces the overlay set, including after an uncertain transport failure. */
  baseRevision: number | null;
  overlays: RecordPatch<string>;
  analysisBase: number | null;
}
export interface AnalysisPatch {
  base: number | null;
  version: number;
  diagnostics?: BasicPlusProjectAnalysis["diagnostics"];
  tokensByFile: RecordPatch<TokenWire>;
  index: {
    symbols: RecordPatch<BasicPlusSymbolIndex["symbols"][string]>;
    occurrencesByFile: RecordPatch<OccurrenceWire>;
    sources: RecordPatch<string>;
    fileContexts: RecordPatch<string>;
    contextFiles: RecordPatch<string[]>;
    scopes?: BasicPlusSymbolIndex["scopes"];
    invalidContexts?: string[];
  };
}
export type LanguageSyncReply =
  { kind: "resync" } | { kind: "result"; session: string; revision: number; patch: AnalysisPatch };

export const equalValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));

export function diffRecord<T>(
  before: Record<string, T> | undefined,
  after: Record<string, T>,
): RecordPatch<T> {
  const set: Record<string, T> = Object.create(null);
  for (const [key, value] of Object.entries(after))
    if (!before || !Object.hasOwn(before, key) || !equalValue(before[key], value)) set[key] = value;
  return {
    set,
    removed: before ? Object.keys(before).filter((key) => !Object.hasOwn(after, key)) : [],
  };
}
export function applyRecord<T>(
  before: Record<string, T>,
  patch: RecordPatch<T>,
): Record<string, T> {
  if (!patch.removed.length && !Object.keys(patch.set).length) return before;
  const result = Object.assign(Object.create(null) as Record<string, T>, before, patch.set);
  for (const key of patch.removed) delete result[key];
  return result;
}
export function emptyAnalysis(): BasicPlusProjectAnalysis {
  return {
    diagnostics: [],
    tokensByFile: Object.create(null),
    index: {
      symbols: Object.create(null),
      occurrencesByFile: Object.create(null),
      sources: Object.create(null),
      fileContexts: Object.create(null),
      contextFiles: Object.create(null),
      scopes: [],
      invalidContexts: [],
    },
  };
}
/** Run in the worker: unchanged files, symbols and source text never cross IPC. */
export function diffAnalysis(
  before: BasicPlusProjectAnalysis | undefined,
  after: BasicPlusProjectAnalysis,
  base: number | null,
  version: number,
): AnalysisPatch {
  return {
    base: before ? base : null,
    version,
    ...(!before || !equalValue(before.diagnostics, after.diagnostics)
      ? { diagnostics: after.diagnostics }
      : {}),
    tokensByFile: mapPatch(diffRecord(before?.tokensByFile, after.tokensByFile), packTokens),
    index: {
      symbols: diffRecord(before?.index.symbols, after.index.symbols),
      occurrencesByFile: mapPatch(
        diffRecord(before?.index.occurrencesByFile, after.index.occurrencesByFile),
        packOccurrences,
      ),
      sources: diffRecord(before?.index.sources, after.index.sources),
      fileContexts: diffRecord(before?.index.fileContexts, after.index.fileContexts),
      contextFiles: diffRecord(before?.index.contextFiles, after.index.contextFiles),
      ...(!before || !equalValue(before.index.scopes, after.index.scopes)
        ? { scopes: after.index.scopes }
        : {}),
      ...(!before || !equalValue(before.index.invalidContexts, after.index.invalidContexts)
        ? { invalidContexts: after.index.invalidContexts }
        : {}),
    },
  };
}
/** Retain immutable identities for unchanged token arrays and index sections. */
export function applyAnalysis(
  before: { version: number; analysis: BasicPlusProjectAnalysis } | undefined,
  patch: AnalysisPatch,
) {
  if (patch.base !== null && before?.version !== patch.base)
    throw new Error("Analysis base version mismatch.");
  const old = patch.base === null ? emptyAnalysis() : before!.analysis;
  return {
    version: patch.version,
    analysis: {
      diagnostics: patch.diagnostics ?? old.diagnostics,
      tokensByFile: applyRecord(old.tokensByFile, mapPatch(patch.tokensByFile, unpackTokens)),
      index: {
        symbols: applyRecord(old.index.symbols, patch.index.symbols),
        occurrencesByFile: applyRecord(
          old.index.occurrencesByFile,
          mapPatch(patch.index.occurrencesByFile, unpackOccurrences),
        ),
        sources: applyRecord(old.index.sources, patch.index.sources),
        fileContexts: applyRecord(old.index.fileContexts, patch.index.fileContexts),
        contextFiles: applyRecord(old.index.contextFiles, patch.index.contextFiles),
        scopes: patch.index.scopes ?? old.index.scopes,
        invalidContexts: patch.index.invalidContexts ?? old.index.invalidContexts,
      },
    },
  };
}
