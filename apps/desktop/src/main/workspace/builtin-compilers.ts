import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import type { CompilerBackend, LanguageFrontend } from "@kobrixa/compiler";
import { BuildError } from "../../../../../packages/compiler/src/build-error.js";
import type { CompilerSnapshot } from "@kobrixa/plugin-runtime";
import type { BackendDecl } from "@kobrixa/plugin-protocol";

const key = (pluginId: string, id: string): string => `${pluginId}:${id}`;
export const BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>> = {
  "kobrixa.basic-plus:bp": () => new BasicPlusFrontend(),
};
export const BUILTIN_BACKENDS: Readonly<
  Record<string, (declaration: BackendDecl, irVersion: number) => CompilerBackend>
> = {
  "kobrixa.ev3:ev3-native": (declaration, irVersion) => ({
    id: declaration.target,
    declaration: structuredClone(declaration),
    irVersion,
    async compile(ir, signal) {
      const result = await new EV3Backend().compile(ir, signal);
      return {
        artifacts: [
          ...(result.rbf ? [{ slot: "program", data: result.rbf }] : []),
          ...(result.listing === undefined
            ? []
            : [{ slot: "listing", data: new TextEncoder().encode(result.listing) }]),
        ],
        diagnostics: result.diagnostics,
      };
    },
  }),
};
export function createBuiltinCompilers(snapshot: CompilerSnapshot): {
  frontend: LanguageFrontend;
  backend: CompilerBackend;
} {
  const front = snapshot.frontend;
  const back = snapshot.backend;
  const createFrontend = BUILTIN_FRONTENDS[key(front.pluginId, front.contribution.language)];
  const createBackend = BUILTIN_BACKENDS[key(back.pluginId, back.contribution.target)];
  if (!createFrontend || !createBackend)
    throw new BuildError(
      "BUILD1001",
      "No built-in compiler factory matches the provider snapshot.",
    );
  return { frontend: createFrontend(), backend: createBackend(back.contribution, snapshot.ir) };
}
