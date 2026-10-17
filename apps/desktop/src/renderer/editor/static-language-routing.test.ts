import { expect, it } from "vitest";
import type { LanguageBinding } from "../../shared/language-services.js";
import type {
  StaticLanguageOwner,
  StaticLanguagesCatalog,
  ValidatedStaticLanguage,
} from "../../shared/static-languages.js";
import { resolveLexicalLanguage } from "./static-language-routing.js";

function language(id: string, extensions = ["toy"]): ValidatedStaticLanguage {
  return {
    id,
    extensions,
    pluginId: `acme.${id}`,
    sourceKey: `development:${id}`,
    generation: 1,
    aliases: [`Language ${id}`],
    resourceDigest: `digest:${id}`,
    tokenizer: { ignoreCase: false, states: [{ name: "root", rules: [] }] },
    configuration: {},
    resourceBytes: { tokenizer: 64, configuration: 3 },
    expandedRules: 0,
  };
}
const a = language("toy-a", ["toy", "a"]);
const b = language("toy-b", ["toy", "b"]);
const owner = (value: ValidatedStaticLanguage): StaticLanguageOwner => ({
  pluginId: value.pluginId,
  sourceKey: value.sourceKey,
  generation: value.generation,
  languageId: value.id,
  extensions: value.extensions,
});
const binding: LanguageBinding = {
  pluginId: a.pluginId,
  sourceKey: a.sourceKey,
  language: a.id,
  epoch: 19,
  extensions: a.extensions,
  capabilities: ["analysis"],
  frontend: {
    language: a.id,
    entryExtensions: ["a"],
    sourceExtensions: a.extensions,
    ir: { min: 1, max: 1 },
  },
};
const catalog: StaticLanguagesCatalog = {
  formatVersion: 1,
  limitsVersion: 1,
  revision: 7,
  languages: [a, b],
  extensionRoutes: { toy: null, a: a.id, b: b.id },
  conflicts: [],
};
const input = {
  file: "main.toy",
  catalog,
  activeOwners: [owner(a), owner(b)],
  coreExtensionRoutes: { json: "json" },
};

it("keeps core routes first and uses only the final case-insensitive extension", () => {
  expect(
    resolveLexicalLanguage({ ...input, file: "C:\\project.toy\\MAIN.JSON", binding }),
  ).toMatchObject({ monacoLanguage: "json", displayName: "JSON", kind: "core" });
  for (const file of ["README", "main.a.txt", "folder.a/README", "main."]) {
    expect(resolveLexicalLanguage({ ...input, file }).monacoLanguage).toBe("plaintext");
  }
  expect(resolveLexicalLanguage({ ...input, file: "中文.A" })).toMatchObject({
    monacoLanguage: "toy-a",
    displayName: "Language toy-a",
    catalogRevision: 7,
    staticOwner: {
      pluginId: a.pluginId,
      sourceKey: a.sourceKey,
      generation: a.generation,
      languageId: a.id,
    },
  });
});

it("uses an applicable selected owner to disambiguate without crossing owners", () => {
  expect(resolveLexicalLanguage(input).monacoLanguage).toBe("plaintext");
  expect(resolveLexicalLanguage({ ...input, binding }).monacoLanguage).toBe("toy-a");
  expect(
    resolveLexicalLanguage({ ...input, binding, activeOwners: [owner(b)] }).monacoLanguage,
  ).toBe("plaintext");
  expect(
    resolveLexicalLanguage({ ...input, binding: { ...binding, sourceKey: "other" } })
      .monacoLanguage,
  ).toBe("plaintext");
  expect(resolveLexicalLanguage({ ...input, binding, file: "main.b" }).monacoLanguage).toBe(
    "toy-b",
  );
  expect(
    resolveLexicalLanguage({
      ...input,
      file: "main.a",
      activeOwners: [{ ...owner(a), generation: 2 }],
    }).monacoLanguage,
  ).toBe("plaintext");
});

it("does not infer Basic Plus or read inherited route keys", () => {
  const inherited = Object.create({ toy: "toy-a" }) as Record<string, string | null>;
  expect(
    resolveLexicalLanguage({ ...input, catalog: { ...catalog, extensionRoutes: inherited } })
      .monacoLanguage,
  ).toBe("plaintext");
  const core = Object.create({ toy: "json" }) as Record<string, string>;
  expect(resolveLexicalLanguage({ ...input, coreExtensionRoutes: core }).monacoLanguage).toBe(
    "plaintext",
  );
  expect(resolveLexicalLanguage({ ...input, file: "main.bp" }).monacoLanguage).toBe("plaintext");
  expect(
    resolveLexicalLanguage({
      ...input,
      file: "main.a",
      catalog: {
        ...catalog,
        languages: [{ ...a, aliases: [] }, b],
      },
    }).displayName,
  ).toBe("toy-a");
});
