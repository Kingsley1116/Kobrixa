import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readSource, resolvePlugins } from "./index.js";
const cases = JSON.parse(
  await readFile(new URL("../../plugin-protocol/conformance/cases.json", import.meta.url), "utf8"),
) as Array<{
  name: string;
  value: unknown;
  registry?: { source: "builtin" | "development"; codes: string[] };
}>;
it.each(cases.filter((item) => item.registry))("registry: $name", async (item) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-service-conformance-"));
  try {
    await writeFile(path.join(root, "kobrixa-plugin.json"), JSON.stringify(item.value));
    await writeFile(path.join(root, "main.js"), "");
    const read = await readSource(
      item.registry!.source === "builtin"
        ? { kind: "builtin", policy: "required", resources: {}, manifest: item.value }
        : { kind: "development", directory: root },
      { safeMode: false },
    );
    const [plugin] = resolvePlugins([read], { safeMode: false, disabled: new Set() });
    expect(plugin!.problems.map((p) => p.code).sort()).toEqual([...item.registry!.codes].sort());
    expect(plugin!.status).toBe(item.registry!.codes.length ? "invalid" : "enabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
