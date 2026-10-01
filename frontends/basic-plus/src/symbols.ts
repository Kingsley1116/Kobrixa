import path from "node:path";
import type { FunctionDeclaration } from "./ast.js";

export function canonical(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

/** Preserve unqualified and filename-qualified function lookup precedence. */
export function functionSymbols(
  declarations: FunctionDeclaration[],
  duplicate: (declaration: FunctionDeclaration) => void = () => undefined,
): Map<string, FunctionDeclaration> {
  const known = new Map<string, FunctionDeclaration>();
  for (const declaration of declarations) {
    const key = canonical(declaration.name);
    if (known.has(key)) duplicate(declaration);
    known.set(key, declaration);
    const moduleName = path.posix.basename(
      declaration.span.file,
      path.posix.extname(declaration.span.file),
    );
    const qualified = canonical(`${moduleName}.${declaration.name}`);
    if (!known.has(qualified)) known.set(qualified, declaration);
  }
  return known;
}

/** @ chooses storage for new bindings; existing parameters/locals retain precedence. */
export function resolveVariable<T>(
  name: string,
  locals: Map<string, T>,
  globals: Map<string, T>,
  global: boolean,
  create: (key: string, scope: "local" | "global") => T,
): T {
  const key = canonical(name);
  const existing = locals.get(key) ?? globals.get(key);
  if (existing) return existing;
  const value = create(key, global ? "global" : "local");
  locals.set(key, value);
  if (global) globals.set(key, value);
  return value;
}
