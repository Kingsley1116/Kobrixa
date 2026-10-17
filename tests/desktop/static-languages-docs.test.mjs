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
