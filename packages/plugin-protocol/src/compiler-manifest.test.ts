import { expect, it } from "vitest";
import { PLUGIN_API_VERSION, pluginManifestSchema, compilerDeclarationProblems } from "./index.js";

const frontend = {
  language: "bp",
  entryExtensions: ["bp"],
  sourceExtensions: ["bp", "bpi", "bpm"],
  ir: { min: 1, max: 1 },
};
const main = {
  slot: "program",
  kind: "rbf",
  extension: "rbf",
  mediaType: "application/octet-stream",
  role: "deploy-main" as const,
  required: true,
};
const backend = {
  target: "ev3-native",
  ir: { min: 1, max: 1 },
  capabilities: { deploy: "ev3" as const },
  artifacts: [main],
};
const manifest = {
  id: "test.compiler",
  version: "1.0.0",
  apiVersion: "^1.1.0",
  runtime: { kind: "builtin" as const },
  contributes: { frontends: [frontend], backends: [backend] },
};
it("exports API 1.2 and accepts complete compiler declarations", () => {
  expect(PLUGIN_API_VERSION).toBe("1.2.0");
  expect(pluginManifestSchema.parse(manifest).contributes?.backends).toEqual([backend]);
  expect(compilerDeclarationProblems(pluginManifestSchema.parse(manifest))).toEqual([]);
});
it("checks semantic relations without hiding them in the wire schema", () => {
  for (const contributes of [
    { frontends: [{ ...frontend, entryExtensions: ["py"] }] },
    { frontends: [{ ...frontend, ir: { min: 2, max: 1 } }] },
    { backends: [{ ...backend, ir: { min: 2, max: 1 } }] },
    { backends: [{ ...backend, artifacts: [] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, required: false }] }] },
    { backends: [{ ...backend, artifacts: [main, { ...main, slot: "second" }] }] },
    { backends: [{ ...backend, artifacts: [main, { ...main, role: "aux" }] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, slot: "ir" }] }] },
    { backends: [{ ...backend, artifacts: [{ ...main, slot: "asset" }] }] },
  ])
    expect(
      compilerDeclarationProblems(pluginManifestSchema.parse({ ...manifest, contributes })),
    ).not.toEqual([]);
});
it("bounds both provider arrays and each artifact declaration array", () => {
  for (const [field, value, limit] of [
    ["frontends", frontend, 8],
    ["backends", backend, 8],
  ] as const) {
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: { [field]: Array(limit).fill(value) },
      }).success,
    ).toBe(true);
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: { [field]: Array(limit + 1).fill(value) },
      }).success,
    ).toBe(false);
  }
  for (const count of [16, 17])
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          backends: [
            {
              ...backend,
              artifacts: Array.from({ length: count }, (_, i) => ({ ...main, slot: `s${i}` })),
            },
          ],
        },
      }).success,
    ).toBe(count === 16);
});
