import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DIAGNOSTIC_HELP_LIMITS } from "@kobrixa/plugin-protocol";
import { readDiagnosticHelp } from "./diagnostic-help.js";

let root: string;
let plugin: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-help-"));
  plugin = path.join(root, "plugin");
  await mkdir(plugin);
});
afterEach(() => rm(root, { recursive: true, force: true }));
const entry = {
  code: "ACME100",
  title: { en: "Failed" },
  cause: { en: "Because" },
  steps: { en: ["Retry"] },
};
const decl = (p = "help.json") => ({ version: 1 as const, path: p });
const write = (name: string, value: unknown) =>
  writeFile(path.join(plugin, name), typeof value === "string" ? value : JSON.stringify(value));

it("reads a valid file with a byte order mark", async () => {
  const body = `\uFEFF${JSON.stringify({ entries: [entry] })}`;
  await write("help.json", body);
  const result = await readDiagnosticHelp(plugin, decl());
  expect(result).toMatchObject({
    ok: true,
    help: { entries: [entry], bytes: Buffer.byteLength(body) },
  });
});
it("rejects a symlink that escapes the plugin folder", async () => {
  await writeFile(path.join(root, "outside.json"), JSON.stringify({ entries: [entry] }));
  await symlink(path.join(root, "outside.json"), path.join(plugin, "help.json"));
  expect(await readDiagnosticHelp(plugin, decl())).toMatchObject({
    ok: false,
    problem: { code: "PLUGIN_E_DIAGNOSTIC_HELP" },
  });
});
it("rejects directories, missing files, invalid JSON and schema failures", async () => {
  await mkdir(path.join(plugin, "dir.json"));
  await write("bad.json", "{");
  await write("schema.json", { entries: [{ ...entry, source: "x.y" }] });
  await write("dup.json", { entries: [entry, entry] });
  for (const name of ["dir.json", "missing.json", "bad.json", "schema.json", "dup.json"])
    expect((await readDiagnosticHelp(plugin, decl(name))).ok).toBe(false);
});
it("accepts a file exactly at the size limit and rejects one byte more", async () => {
  const body = JSON.stringify({ entries: [entry] });
  const padded = body + " ".repeat(DIAGNOSTIC_HELP_LIMITS.fileBytes - Buffer.byteLength(body));
  await write("max.json", padded);
  await write("over.json", padded + " ");
  expect((await readDiagnosticHelp(plugin, decl("max.json"))).ok).toBe(true);
  expect(await readDiagnosticHelp(plugin, decl("over.json"))).toMatchObject({
    ok: false,
    problem: { message: expect.stringMatching(/1 MiB/) },
  });
});
it("rejects a file that grows past the limit after stat", async () => {
  await write("grow.json", JSON.stringify({ entries: [entry] }));
  // The size decision must come from the bounded read, not only from stat.
  const growingStat = async (file: string) => {
    const info = await stat(file);
    await appendFile(file, " ".repeat(DIAGNOSTIC_HELP_LIMITS.fileBytes));
    return info;
  };
  expect(await readDiagnosticHelp(plugin, decl("grow.json"), { stat: growingStat })).toMatchObject({
    ok: false,
    problem: { message: expect.stringMatching(/1 MiB/) },
  });
});
