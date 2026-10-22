// Execute the actual resource validator and default packaged catalog reader.
// This collector records software boundaries, not native UI/process acceptance.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { UiCatalog, readSource } from "../../packages/plugin-runtime/dist/index.js";
import {
  UI_LIMITS_V1 as L,
  validateUiResource,
} from "../../packages/plugin-protocol/dist/index.js";
import { mutations, padJson, readFixtures, root } from "./declarative-ui-harness.mjs";

const output = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "provide a fresh evidence output directory");
await mkdir(output); // Never overwrite a previous experiment.
await mkdir(path.join(output, "inputs"));
const working = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-ui-resources-")));
const epoch = randomUUID();
const observed = [];
const inputs = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = await readFixtures();
const context = {
  pluginId: fixture.manifest.id,
  commands: fixture.manifest.contributes.commands,
  panels: fixture.manifest.contributes.panels,
};
async function retain(raw) {
  const bytes = Buffer.from(raw, "utf8");
  const hash = sha(bytes);
  if (!inputs.has(hash)) {
    const file = `inputs/${hash}.json.gz`;
    const compressed = gzipSync(bytes, { mtime: 0 });
    await writeFile(path.join(output, file), compressed);
    inputs.set(hash, {
      file,
      bytes: bytes.length,
      sha256: hash,
      compressedSha256: sha(compressed),
    });
  }
  return hash;
}
async function validate(id, resource, expected, raw = JSON.stringify(resource), version = 1) {
  const result = validateUiResource(resource, context, Buffer.byteLength(raw), version);
  observed.push({ id, producer: "validateUiResource", input: await retain(raw), version, result });
  assert.equal(result.ok, expected, id);
  return result;
}
const barePanel = {
  kind: "panel",
  root: "root",
  data: {},
  fields: {},
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["text"] },
    { id: "text", type: "help", value: { text: { en: "界🙂" } } },
  ],
};
const bareStatus = { kind: "status", text: { text: { en: "界🙂" } }, tone: "neutral", data: {} };
async function pages(catalog) {
  const entries = [];
  let cursor;
  do {
    const result = await catalog.catalog(cursor ? { cursor } : {});
    assert.equal(result.ok, true);
    entries.push(...result.value.entries);
    cursor = result.value.nextCursor;
  } while (cursor);
  return entries;
}
let number = 0;
async function source(sizes, prefix = "source") {
  const id = `acceptance.r${number++}`;
  const directory = path.join(working, `${prefix}-${id}`);
  await mkdir(directory);
  const declarations = [];
  const rawInputs = [];
  for (const [index, bytes] of sizes.entries()) {
    const kind = index < 4 ? "panel" : "status";
    const file = `${index}.json`;
    const raw = padJson(kind === "panel" ? barePanel : bareStatus, bytes);
    await writeFile(path.join(directory, file), raw);
    rawInputs.push({ path: file, bytes: Buffer.byteLength(raw), sha256: await retain(raw) });
    declarations.push({
      kind,
      id: `${id}.r${index}`,
      title: { en: `Resource ${index}` },
      resource: { version: 1, path: file },
      ...(kind === "panel" ? { location: "right" } : {}),
    });
  }
  return {
    input: {
      owner: {
        sourceKey: `dev:${String(number).padStart(16, "0")}`,
        pluginId: id,
        generation: 1,
        hostEpoch: epoch,
        processEpoch: randomUUID(),
      },
      eligible: true,
      resources: { kind: "packaged", root: directory },
      commands: [],
      panels: declarations
        .filter((d) => d.kind === "panel")
        .map((d) => ({ id: d.id, title: d.title, resource: d.resource, location: "right" })),
      status: declarations
        .filter((d) => d.kind === "status")
        .map((d) => ({ id: d.id, title: d.title, resource: d.resource })),
    },
    rawInputs,
  };
}
async function catalogCase(id, sources, expectedAvailable) {
  const catalog = new UiCatalog(epoch); // No reader/validator/budget overrides.
  await catalog.replace(sources.map((s) => s.input));
  const entries = await pages(catalog);
  const outcomes = [];
  for (const entry of entries) {
    const result = await catalog.resource({
      sourceKey: entry.sourceKey,
      id: entry.id,
      uiResourceGeneration: entry.uiResourceGeneration,
      resourceDigest: entry.resourceDigest,
    });
    outcomes.push({ entry, result });
  }
  observed.push({ id, producer: "UiCatalog/default-packaged-reader", sources, outcomes });
  assert.equal(entries.filter((e) => e.availability === "available").length, expectedAvailable, id);
  return outcomes;
}
async function discoveryCase(id, source, expected, amend = () => {}) {
  const input = source.input;
  const manifest = {
    id: input.owner.pluginId,
    version: "1.0.0",
    apiVersion: "^1.6.0",
    runtime: { kind: "node", entry: "main.cjs" },
    permissions: ["ui.panels", "ui.status"],
    contributes: { commands: input.commands, panels: input.panels, status: input.status },
  };
  amend(manifest);
  await writeFile(path.join(input.resources.root, "kobrixa-plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(input.resources.root, "main.cjs"),
    'throw new Error("Resource discovery must not execute the entry");',
  );
  const result = await readSource(
    { kind: "development", directory: input.resources.root },
    { safeMode: false },
  );
  observed.push({
    id,
    producer: "readSource/default-development-discovery",
    manifest: await retain(JSON.stringify(manifest)),
    result: {
      id: result.id,
      sourceKey: result.sourceKey,
      problems: result.problems,
      entry: result.entry,
    },
  });
  assert.equal(result.problems.length === 0, expected, id);
}
try {
  const maximum = JSON.parse(
    await readFile(
      path.join(root, "packages/plugin-protocol/test-fixtures/declarative-ui-v1/maximum.json"),
      "utf8",
    ),
  );
  const nodes = structuredClone(maximum.cases.find((c) => c.id === "U03 nodes 256").input.resource);
  for (const count of [255, 256, 257]) {
    const resource = structuredClone(nodes);
    if (count === 255) {
      const removed = resource.nodes.pop();
      const parent = resource.nodes.find(
        (n) => n.type === "group" && n.children.includes(removed.id),
      );
      parent.children = parent.children.filter((id) => id !== removed.id);
    } else if (count === 257) {
      const parent = resource.nodes.find((n) => n.type === "group" && n.children.length < 32);
      parent.children.push("extra");
      resource.nodes.push({ id: "extra", type: "help", value: { text: { en: "extra" } } });
    }
    assert.equal(resource.nodes.length, count);
    await validate(`nodes/${count}`, resource, count <= L.nodes);
  }
  for (const depth of [7, 8, 9]) {
    const resource = structuredClone(barePanel);
    for (let n = 2; n < depth; n++) {
      resource.nodes.push({
        id: `g${n}`,
        type: "group",
        layout: "stack",
        children: [resource.root],
      });
      resource.root = `g${n}`;
    }
    await validate(`depth/${depth}`, resource, depth <= L.depth);
  }
  for (const count of [3999, 4000, 4001]) {
    const resource = structuredClone(barePanel);
    resource.nodes[1].value.text.en =
      "🙂界".repeat(Math.floor(count / 2)) + (count % 2 ? "🙂" : "");
    assert.equal([...resource.nodes[1].value.text.en].length, count);
    await validate(`codePoints/${count}`, resource, count <= L.stringCodePoints);
  }
  for (const count of [199, 200, 201]) {
    const resource = structuredClone(barePanel);
    resource.nodes[0].label = { en: "🙂".repeat(count) };
    await validate(`labelCodePoints/${count}`, resource, count <= L.labelCodePoints);
  }
  for (const bytes of [L.resourceBytes - 1, L.resourceBytes, L.resourceBytes + 1]) {
    const raw = padJson(barePanel, bytes);
    await validate(`utf8/${bytes}`, barePanel, bytes <= L.resourceBytes, raw);
    await catalogCase(
      `resourceBytes/${bytes}`,
      [await source([bytes])],
      bytes <= L.resourceBytes ? 1 : 0,
    );
  }
  // Five declarations isolate the source sum from each individual file's ceiling.
  const tail = Buffer.byteLength(JSON.stringify(bareStatus));
  for (const delta of [-1, 0, 1]) {
    const sizes = [
      L.resourceBytes,
      L.resourceBytes,
      L.resourceBytes,
      L.resourceBytes - tail + delta,
      tail,
    ];
    assert.equal(
      sizes.reduce((a, b) => a + b),
      L.sourceBytes + delta,
    );
    await catalogCase(
      `sourceBytes/${L.sourceBytes + delta}`,
      [await source(sizes)],
      delta > 0 ? 4 : 5,
    );
  }
  // Nine individually valid sources isolate the global sum from per-source limits.
  const leafBytes = Buffer.byteLength(JSON.stringify(barePanel));
  for (const delta of [-1, 0, 1]) {
    const sources = [];
    for (let n = 0; n < 8; n++)
      sources.push(
        await source([
          L.resourceBytes,
          L.resourceBytes,
          L.resourceBytes,
          L.resourceBytes - (n === 7 ? leafBytes - delta : 0),
        ]),
      );
    sources.push(await source([leafBytes]));
    assert.equal(
      sources.flatMap((s) => s.rawInputs).reduce((sum, f) => sum + f.bytes, 0),
      L.hostBytes + delta,
    );
    await catalogCase(`hostBytes/${L.hostBytes + delta}`, sources, delta > 0 ? 32 : 33);
  }
  const repeated = await source([
    L.resourceBytes,
    L.resourceBytes,
    L.resourceBytes,
    L.resourceBytes,
    tail,
  ]);
  for (const declaration of repeated.input.panels) declaration.resource.path = "0.json";
  const repeats = await catalogCase("repeated-path-charged", [repeated], 4);
  assert.equal(new Set(repeats.slice(0, 4).map((r) => r.entry.resourceDigest)).size, 1);
  assert.equal(repeats[4].entry.availability, "unavailable");
  const repeatedSources = [];
  for (let n = 0; n < 8; n++) {
    const input = await source([
      L.resourceBytes,
      L.resourceBytes,
      L.resourceBytes,
      L.resourceBytes,
    ]);
    for (const declaration of input.input.panels) declaration.resource.path = "0.json";
    repeatedSources.push(input);
  }
  repeatedSources.push(await source([leafBytes]));
  await catalogCase("repeated-path-host-charged", repeatedSources, 32);

  const typeMismatch = structuredClone(fixture.panel);
  typeMismatch.nodes.find((node) => node.id === "speed").field = "enabled";
  const duplicateParent = structuredClone(fixture.panel);
  duplicateParent.nodes[0].children.push("second-parent");
  duplicateParent.nodes.push({
    id: "second-parent",
    type: "group",
    layout: "stack",
    children: ["speed"],
  });
  for (const mutation of [
    ...mutations(fixture.panel),
    { id: "input-type-mismatch", resource: typeMismatch },
    { id: "duplicate-parent", resource: duplicateParent },
  ]) {
    const validation = await validate(`negative/${mutation.id}`, mutation.resource, false);
    assert.equal(validation.error.code, "PLUGIN_E_UI_RESOURCE");
    assert.ok(validation.error.detail.reason);
    const input = await source([Buffer.byteLength(JSON.stringify(mutation.resource)), 200]);
    await writeFile(
      path.join(input.input.resources.root, "0.json"),
      JSON.stringify(mutation.resource),
    );
    input.rawInputs[0].sha256 = await retain(JSON.stringify(mutation.resource));
    input.input.commands = fixture.manifest.contributes.commands;
    input.input.owner.pluginId = fixture.manifest.id;
    for (const declaration of input.input.panels)
      declaration.id = `${fixture.manifest.id}.${declaration.id.split(".").at(-1)}`;
    await discoveryCase(`discovery/${mutation.id}`, input, true);
    const outcomes = await catalogCase(`loader-negative/${mutation.id}`, [input], 1);
    assert.equal(outcomes[0].entry.problem.code, validation.error.code);
    assert.deepEqual(outcomes[0].result.error.detail, { kind: "ui", reason: "renderer" });
  }
  for (const location of ["../outside.json", "/outside.json", "sub\\outside.json"]) {
    const input = await source([500, 500]);
    input.input.panels[0].resource.path = location;
    await discoveryCase(`discovery-path/${location}`, input, true);
    await catalogCase(`path/${location}`, [input], 1);
  }
  const link = await source([500, 500]);
  await writeFile(path.join(working, "outside.json"), JSON.stringify(barePanel));
  await rm(path.join(link.input.resources.root, "0.json"));
  await symlink(path.join(working, "outside.json"), path.join(link.input.resources.root, "0.json"));
  await catalogCase("symlink-escape", [link], 1);
  const version = await source([500, 500]);
  version.input.panels[0].resource.version = 2;
  await discoveryCase("discovery-version/2", version, true);
  const outcomes = await catalogCase("unsupported-version", [version], 1);
  assert.equal(outcomes[0].entry.problem.code, "PLUGIN_E_UI_VERSION");
  await discoveryCase(
    "manifest/resource-extra-key",
    await source([500, 500]),
    false,
    (manifest) => {
      manifest.contributes.panels[0].resource.unknown = true;
    },
  );
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        version: 1,
        kind: "ui-resource-software-evidence",
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        fixtureOnly: true,
        inputs: [...inputs.values()],
        observed,
      },
      null,
      2,
    ),
  );
  console.log(`PASS ${observed.length} actual software resource cases: ${output}`);
} finally {
  await rm(working, { recursive: true, force: true });
}
