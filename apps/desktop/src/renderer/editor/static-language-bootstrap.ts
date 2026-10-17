import type { StaticLanguageRegistrar } from "./static-language-registration.js";
import type { StaticLanguageStore } from "./static-language-store.js";

export interface StaticLanguageBootstrapInput {
  store: StaticLanguageStore;
  registrar: StaticLanguageRegistrar;
  /** Defaults to 5,000; test clocks may shorten it, production cannot raise it. */
  timeoutMs?: number;
}
export type StaticLanguageBootstrapResult =
  | { kind: "ready"; revision: number }
  | { kind: "plaintext"; reason: "ipc" | "timeout"; message: string };

/** app.tsx shares this barrier with every entry point that can create document models. */
export function bootstrapStaticLanguages(
  input: StaticLanguageBootstrapInput,
): Promise<StaticLanguageBootstrapResult> {
  void input;
  return Promise.resolve({ kind: "plaintext", reason: "ipc", message: "not implemented" });
}
