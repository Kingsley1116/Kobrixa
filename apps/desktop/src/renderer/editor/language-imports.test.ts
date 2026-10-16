import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
const root = fileURLToPath(new URL("../../", import.meta.url));
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(path.join(directory, entry.name))
          : Promise.resolve([path.join(directory, entry.name)]),
      ),
    )
  ).flat();
}
it("keeps Basic Plus imports inside the browser companion and worker adapters", async () => {
  const violations: string[] = [];
  for (const file of [
    ...(await files(path.join(root, "renderer"))),
    ...(await files(path.join(root, "shared"))),
  ]) {
    if (
      !/\.tsx?$/.test(file) ||
      file.includes("/companions/basic-plus/") ||
      /\.test\.tsx?$/.test(file)
    )
      continue;
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^@kobrixa\/basic-plus(?:\/|$)/.test(node.text))
        violations.push(file);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(violations).toEqual([]);
});
