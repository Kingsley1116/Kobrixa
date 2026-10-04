import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  diagnosticDocumentationUrl,
  getDiagnosticHelp,
} from "./diagnostic-help.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function productionFiles(directory: string): Promise<string[]> {
  const children = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      children.map(async (child) => {
        const file = path.join(directory, child.name);
        if (child.isDirectory()) return productionFiles(file);
        return child.name.endsWith(".ts") &&
          !child.name.endsWith(".test.ts") &&
          !child.name.startsWith("diagnostic-help")
          ? [file]
          : [];
      }),
    )
  ).flat();
}

describe("diagnostic documentation", () => {
  it("covers exactly the diagnostic codes emitted by production producers", async () => {
    const directories = [
      "frontends/basic-plus/src",
      "packages/compiler/src",
      "packages/ir/src",
      "packages/backend-ev3/src",
    ];
    const files = (
      await Promise.all(directories.map((dir) => productionFiles(path.join(root, dir))))
    ).flat();
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    const codes = [
      ...new Set(
        contents.flatMap((source) =>
          [...source.matchAll(/["']((?:BP|MAN|IR|EV3|BUILD)\d{4})["']/g)].map((match) => match[1]!),
        ),
      ),
    ].sort();
    expect(DIAGNOSTIC_HELP.map((help) => help.code).sort()).toEqual(codes);
    expect(new Set(DIAGNOSTIC_HELP.map((help) => help.code)).size).toBe(87);
    expect(
      Object.fromEntries(
        ["BP", "MAN", "IR", "EV3", "BUILD"].map((prefix) => [
          prefix,
          codes.filter((code) => code.startsWith(prefix)).length,
        ]),
      ),
    ).toEqual({ BP: 50, MAN: 4, IR: 12, EV3: 19, BUILD: 2 });
  });

  it("provides complete bilingual explanations and existing documentation links", async () => {
    for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS]) {
      expect(help.keywords.length, help.code).toBeGreaterThan(0);
      for (const locale of ["zh-TW", "en"] as const) {
        expect(help.title[locale].length, help.code).toBeGreaterThan(3);
        expect(help.cause[locale].length, help.code).toBeGreaterThan(10);
        expect(help.steps[locale].length, help.code).toBeGreaterThan(0);
        expect(
          help.steps[locale].every((step) => step.trim().length > 5),
          help.code,
        ).toBe(true);
        for (const reference of help.related) {
          expect(reference.label[locale].length, help.code).toBeGreaterThan(0);
          expect(reference.path).toMatch(/^\/docs\/(?:reference|tutorial)\/[a-z-]+$/);
          if (reference.path === "/docs/reference/basic-plus") continue;
          const [, , section, slug] = reference.path.split("/");
          if (section === "reference") {
            expect(
              await readFile(path.join(root, `docs/${locale}/${slug}.md`), "utf8"),
            ).toBeTruthy();
          } else {
            const docs = await readdir(path.join(root, `docs/tutorials/${locale}`));
            const matches = docs.filter((name) => name.endsWith(`-${slug}.md`));
            expect(matches.length, `${help.code}: ${reference.path}`).toBe(1);
          }
        }
      }
      if (help.example) {
        expect(help.example.before).not.toEqual(help.example.after);
        expect(help.example.after.trim()).not.toBe("");
      }
    }
  });

  it("uses producer keys for specific explanations and gracefully falls back", () => {
    const keys = DIAGNOSTIC_HELP_VARIANTS.map((help) => `${help.code}:${help.helpKey}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const help of DIAGNOSTIC_HELP_VARIANTS) {
      expect(help.helpKey).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(getDiagnosticHelp(help.code, help.helpKey)).toBe(help);
      expect(getDiagnosticHelp(help.code)).toBeDefined();
    }
    expect(getDiagnosticHelp("BP2006", "unknown-future-condition")).toBe(
      getDiagnosticHelp("BP2006"),
    );
    expect(getDiagnosticHelp("UNKNOWN1000")).toBeUndefined();
  });

  it("only generates official links for known diagnostics and valid locales", () => {
    expect(diagnosticDocumentationUrl("BP2006", "out-type", "zh-TW")).toBe(
      "https://kobrixa.com/docs/diagnostics/BP2006?lang=zh-TW#out-type",
    );
    expect(diagnosticDocumentationUrl("BP2006", "bogus", "en")).toBe(
      "https://kobrixa.com/docs/diagnostics/BP2006?lang=en",
    );
    expect(diagnosticDocumentationUrl("https://example.com", undefined, "en")).toBeUndefined();
    expect(diagnosticDocumentationUrl("BP2006", "../../outside", "en")).not.toContain("outside");
    expect(diagnosticDocumentationUrl("BP2006", undefined, "xx" as "en")).toBeUndefined();
  });

  it("keeps the documentation entrypoint free of runtime imports and Node globals", async () => {
    const source = await readFile(new URL("./diagnostic-help.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bimport\s|\brequire\s*\(|\b(?:process|Buffer)\./);
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    expect(manifest.exports["."]).toBe("./dist/index.js");
    expect(manifest.exports["./diagnostic-help"]).toBe("./dist/diagnostic-help.js");
  });
});
