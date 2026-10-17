import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("clamps every split create and updateOptions call after other options", () => {
  const source = ts.createSourceFile(
    "split-editor.tsx",
    readFileSync(new URL("./split-editor.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const seen: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (name === "create" || name === "updateOptions") {
        const options = node.arguments[name === "create" ? 1 : 0];
        expect(options && ts.isObjectLiteralExpression(options)).toBe(true);
        if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(name);
        expect(options.properties.at(-1)?.getText(source)).toMatch(
          /^maxTokenizationLineLength:\s*10000$/,
        );
        seen.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(seen).toEqual(["create", "updateOptions"]);
});
