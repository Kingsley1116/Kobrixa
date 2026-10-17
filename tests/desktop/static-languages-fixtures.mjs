import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shared = new URL(
  "../../packages/plugin-protocol/test-fixtures/static-languages/",
  import.meta.url,
);
const read = (relative) => readFile(new URL(relative, shared), "utf8");

export async function readStaticLanguageFixtures() {
  const [manifest, toyTokenizer, toyConfiguration, basicPlusTokenizer, basicPlusConfiguration] =
    await Promise.all([
      read("toy/kobrixa-plugin.json"),
      read("toy/language/tokenizer.json"),
      read("toy/language/configuration.json"),
      read("basic-plus/tokenizer.json"),
      read("basic-plus/configuration.json"),
    ]);
  const toyManifest = JSON.parse(manifest);
  const frontend = {
    language: "fixture-owner",
    entryExtensions: ["toy"],
    sourceExtensions: ["toy"],
    ir: { min: 1, max: 1 },
  };
  const binding = {
    epoch: 1,
    pluginId: "kobrixa-smoke.owner",
    sourceKey: "builtin:kobrixa-smoke.owner",
    language: "fixture-owner",
    extensions: ["toy"],
    capabilities: ["analysis"],
    frontend,
  };
  const declaration = structuredClone(toyManifest.contributes.languages[0]);
  declaration.id = binding.language;
  declaration.aliases = ["Fixture owner"];
  const builtin = {
    kind: "builtin",
    manifest: {
      id: binding.pluginId,
      version: "1.0.0",
      apiVersion: "^1.4.0",
      runtime: { kind: "builtin" },
      contributes: {
        frontends: [frontend],
        languageServices: [
          { language: binding.language, extensions: ["toy"], capabilities: ["analysis"] },
        ],
        languages: [declaration],
      },
    },
    resources: {
      "language/tokenizer.json": toyTokenizer,
      "language/configuration.json": toyConfiguration,
    },
  };
  return {
    toyManifest,
    toyTokenizer,
    toyConfiguration,
    basicPlusTokenizer,
    basicPlusConfiguration,
    builtin,
    binding,
  };
}

export async function writeStaticLanguageFixtures(directory) {
  const cases = JSON.parse(
    await readFile(new URL("./fixtures/static-languages/cases.json", import.meta.url), "utf8"),
  );
  const { toyManifest, toyTokenizer } = await readStaticLanguageFixtures();
  await mkdir(directory, { recursive: true });
  const paths = {};
  for (const item of cases) {
    const destination = path.join(directory, item.name);
    await cp(fileURLToPath(new URL("toy/", shared)), destination, { recursive: true });
    paths[item.name] = destination;
    if (item.name === "toy") continue;
    const manifest = structuredClone(toyManifest);
    manifest.id = item.pluginId;
    manifest.contributes.languages[0].id = item.languageId;
    manifest.contributes.languages[0].extensions = item.extensions;
    await writeFile(
      path.join(destination, "kobrixa-plugin.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    if (item.name === "invalid" || item.name === "hostile") {
      const tokenizer = JSON.parse(toyTokenizer);
      if (item.name === "invalid") delete tokenizer.states[0].rules[0].regex.flags;
      else tokenizer.states[0].rules[0].regex.pattern = "(a+)+$";
      await writeFile(
        path.join(destination, "language/tokenizer.json"),
        JSON.stringify(tokenizer, null, 2) + "\n",
      );
    }
  }
  return paths;
}
