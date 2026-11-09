import type { BackendDecl } from "@kobrixa/plugin-protocol";
import type { KobrixaIR } from "@kobrixa/ir";
import type { CompilerBackend, LanguageFrontend, SourceProject } from "./contracts.js";
export const minimalIR: KobrixaIR = {
  version: 1,
  program: { name: "demo", entryFunction: "main" },
  globals: [],
  functions: [
    {
      name: "main",
      parameters: [],
      returnType: { kind: "void" },
      locals: [],
      entryBlock: "entry",
      blocks: [{ id: "entry", instructions: [], terminator: { op: "stop" } }],
    },
  ],
  resources: [],
  sourceFiles: ["main.toy"],
};
export const TEST_BACKEND_DECL: BackendDecl = {
  target: "toy-vm",
  ir: { min: 1, max: 1 },
  capabilities: { deploy: "ev3" },
  artifacts: [
    {
      slot: "program",
      kind: "toy-image",
      extension: "bin",
      mediaType: "application/octet-stream",
      role: "deploy-main",
      required: true,
    },
    {
      slot: "notes",
      kind: "notes",
      extension: "txt",
      mediaType: "text/plain",
      role: "aux",
      required: false,
    },
    {
      slot: "map",
      kind: "source-map",
      extension: "map",
      mediaType: "application/json",
      role: "aux",
      required: false,
    },
  ],
};
export function testProject(root: string): SourceProject {
  return {
    root,
    manifest: {
      schemaVersion: 1,
      name: "demo",
      language: "toy",
      target: "toy-vm",
      entry: "main.toy",
      outputDir: "build",
      assets: [],
    },
    sources: [{ path: "main.toy", content: "test" }],
    assets: [],
  };
}
export const testFrontend: LanguageFrontend = {
  id: "toy",
  compile: async () => ({ ir: structuredClone(minimalIR), diagnostics: [] }),
};
export function testBackend(): CompilerBackend {
  return {
    id: "toy-vm",
    declaration: structuredClone(TEST_BACKEND_DECL),
    irVersion: 1,
    compile: async () => ({
      artifacts: [{ slot: "program", data: new Uint8Array([1, 2, 3]) }],
      diagnostics: [],
    }),
  };
}
