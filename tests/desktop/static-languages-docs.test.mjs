import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readStaticLanguageFixtures } from "./static-languages-fixtures.mjs";

for (const locale of ["en", "zh-TW"]) {
  test(`${locale} author examples equal the frozen T0 toy fixture`, async () => {
    const text = await readFile(
      new URL(`../../docs/${locale}/plugin-static-languages.md`, import.meta.url),
      "utf8",
    );
    const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]),
    );
    const fixture = await readStaticLanguageFixtures();
    assert.deepEqual(examples, [
      fixture.toyManifest,
      JSON.parse(fixture.toyTokenizer),
      JSON.parse(fixture.toyConfiguration),
    ]);
    for (const contract of [
      "^1.4.0",
      "--plugin-dev-dir",
      "--safe-mode",
      "thirdPartyStaticContributions",
      "PLUGIN_E_STATIC_LANGUAGE",
      "PLUGIN_E_STATIC_LANGUAGE_CONFLICT",
      "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
      "PLUGIN_E_BUILTIN_REQUIRED",
      "PLUGIN_E_STATE_SAVE",
      "10,000",
      "5,000",
      "256",
      "257",
    ])
      assert.ok(text.includes(contract), `missing author contract ${contract}`);
    const support = await readFile(
      new URL(`../../docs/${locale}/language-support.md`, import.meta.url),
      "utf8",
    );
    const architecture = await readFile(
      new URL(`../../docs/${locale}/architecture.md`, import.meta.url),
      "utf8",
    );
    assert.match(support, /plugin-static-languages\.md/);
    assert.match(architecture, /thirdPartyStaticContributions/);
    assert.doesNotMatch(
      architecture,
      /Static language contributions are reserved for 2C|靜態語言貢獻留待 2C/,
    );
  });
}

import {
  pluginManifestSchema,
  staticLanguageDeclarationProblems,
  validateStaticLanguageResources,
} from "../../packages/plugin-protocol/dist/index.js";

for (const locale of ["en", "zh-TW"]) {
  test(`${locale} examples pass the actual schema and resource validator`, async () => {
    const text = await readFile(
      new URL(`../../docs/${locale}/plugin-static-languages.md`, import.meta.url),
      "utf8",
    );
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    assert.equal(blocks.length, 3);
    const manifest = pluginManifestSchema.parse(JSON.parse(blocks[0]));
    assert.deepEqual(staticLanguageDeclarationProblems(manifest), []);
    const declaration = manifest.contributes.languages[0];
    const result = validateStaticLanguageResources({
      languageId: declaration.id,
      formatVersion: 1,
      limitsVersion: 1,
      tokenizer: JSON.parse(blocks[1]),
      configuration: JSON.parse(blocks[2]),
      resourceBytes: {
        tokenizer: Buffer.byteLength(blocks[1]),
        configuration: Buffer.byteLength(blocks[2]),
      },
      resourcePaths: {
        tokenizer: declaration.tokenizer.path,
        configuration: declaration.configuration.path,
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}

for (const [locale, contracts] of [
  [
    "en",
    [
      /non-empty.*bracket table/i,
      /case-insensitive.*last filename segment/i,
      /each.*segment.*64 characters/i,
      /all installed Monaco core language ids.*CORE_STATIC_LANGUAGE_IDS/i,
      /symlinked `kobrixa-plugin\.json`.*outside.*plugin folder.*rejected/i,
    ],
  ],
  [
    "zh-TW",
    [
      /非空.*括號表/,
      /最後.*檔名.*不分大小寫/,
      /每個.*路徑.*區段.*64.*字元/,
      /所有已安裝的 Monaco 核心語言 ids.*CORE_STATIC_LANGUAGE_IDS/,
      /`kobrixa-plugin\.json`.*符號連結.*插件資料夾外.*拒絕/,
    ],
  ],
]) {
  test(`${locale} documents brackets, case folding and path segments`, async () => {
    const text = await readFile(
      new URL(`../../docs/${locale}/plugin-static-languages.md`, import.meta.url),
      "utf8",
    );
    for (const contract of contracts) assert.match(text, contract);
  });
}
