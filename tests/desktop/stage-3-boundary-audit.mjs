import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyLeaf } from "./sensor-lab-installed-artifacts.mjs";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");
const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sdkEntry = "packages/plugin-sdk-js/src/index.ts";
const normalize = (name) => path.posix.normalize(name.replaceAll("\\", "/"));
const features = new Set(["sensor-lab", "device-ev3"]);
function featureRoot(feature) {
  assert.ok(features.has(feature), `Unknown feature: ${feature}`);
  return `plugins/${feature}/`;
}

// Pure Lab model/chart/calibration/CSV modules belong to the feature. The old
// desktop DTOs, services, facade and native provider are NOT part of this closure.
export function classifyInput(feature, filename) {
  const name = normalize(filename);
  assert.ok(!name.startsWith("../") && !path.posix.isAbsolute(name), `Foreign input: ${name}`);
  assert.ok(!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name), `Test input: ${name}`);
  if (name.startsWith(`${featureRoot(feature)}src/model/`)) return "pure-feature-model";
  if (name.startsWith(featureRoot(feature))) return "feature";
  if (name.startsWith("packages/plugin-sdk-js/src/")) return "public-sdk";
  if (name.startsWith("packages/plugin-protocol/src/")) return "public-protocol";
  if (
    /^(?:.*\/)?node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:zod|@eslint-community\/regexpp)\//.test(
      name,
    )
  )
    return "public-schema-dependency";
  assert.fail(`Forbidden transitive module: ${name}`);
}

const privateTokens =
  /(?:\b(?:SensorLabService|SensorLabController|SensorLabPanel|DeviceMonitorSnapshot|DeviceInputModes|MonitorService|MonitorController|MonitorWorkspace|MonitorPanel|ipcRenderer|ipcMain|contextBridge)\b|sensor-lab:|motor-test:(?:start|stop|state|keepalive)|\bdevice:[a-z-]+|window\s*\.\s*kobrixa)/;
const forbiddenIdentifiers = new Set([
  "window",
  "globalThis",
  "global",
  "ipcRenderer",
  "ipcMain",
  "contextBridge",
  "require",
  "eval",
  "Function",
  "module",
  "__dirname",
  "__filename",
]);
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}
function member(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text;
}

export function auditSource(feature, source, filename) {
  const name = normalize(filename),
    kind = classifyInput(feature, name);
  assert.notEqual(kind, "public-schema-dependency", "Audit dependency source via bundle closure");
  if (name.endsWith(".json")) {
    assert.doesNotMatch(source, privateTokens, `Private resource: ${name}`);
    return;
  }
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0, `Unparseable source: ${name}`);
  const imports = [];
  function checkImport(specifier, node) {
    assert.equal(typeof specifier, "string", `Nonliteral import: ${name}`);
    if (specifier === "node:crypto") {
      assert.ok(kind === "feature", `Crypto is a feature utility only: ${name}`);
      assert.ok(
        ts.isImportDeclaration(node) &&
          !node.importClause?.name &&
          ts.isNamedImports(node.importClause?.namedBindings),
        `Only named crypto primitives: ${name}`,
      );
      for (const binding of node.importClause.namedBindings.elements)
        assert.ok(
          ["createHash", "randomUUID"].includes((binding.propertyName ?? binding.name).text),
          `Unapproved crypto primitive: ${name}`,
        );
    } else if (specifier.startsWith(".")) {
      const target = normalize(path.posix.join(path.posix.dirname(name), specifier));
      const targetKind = classifyInput(feature, target);
      assert.ok(
        kind === "feature" || kind === "pure-feature-model"
          ? target.startsWith(featureRoot(feature))
          : targetKind === kind,
        `Cross-package relative import: ${name} -> ${specifier}`,
      );
    } else {
      const allowed =
        kind === "feature" || kind === "pure-feature-model"
          ? ["@kobrixa/plugin-sdk", "@kobrixa/plugin-protocol"]
          : kind === "public-sdk"
            ? ["@kobrixa/plugin-protocol"]
            : ["zod", "@eslint-community/regexpp"];
      assert.ok(allowed.includes(specifier), `Nonpublic import: ${name} -> ${specifier}`);
    }
    imports.push(specifier);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkImport(node.moduleSpecifier.text, node);
    }
    if (ts.isImportTypeNode(node)) checkImport(node.argument.literal?.text, node);
    assert.ok(!ts.isImportEqualsDeclaration(node), `Import assignment: ${name}`);
    if (ts.isCallExpression(node))
      assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword, `Dynamic import: ${name}`);
    if (ts.isIdentifier(node)) {
      assert.ok(!forbiddenIdentifiers.has(node.text), `Hidden facade/loader ${node.text}: ${name}`);
      if (kind === "feature" || kind === "pure-feature-model")
        assert.notEqual(node.text, "self", `Global facade: ${name}`);
      assert.doesNotMatch(node.text, privateTokens, `Private identifier: ${name}`);
      if (node.text === "process") {
        let base = node;
        while (base.parent && unwrap(base.parent) === node) base = base.parent;
        const access = base.parent;
        assert.ok(
          name === sdkEntry && ["parentPort", "env", "exit"].includes(member(access)),
          `Process access outside approved SDK transport: ${name}`,
        );
        if (member(access) === "env")
          assert.equal(
            member(access.parent),
            "KOBRIXA_RESOURCE_OWNER",
            "SDK env access is launch-owner only",
          );
      }
    }
    if (ts.isStringLiteralLike(node))
      assert.doesNotMatch(node.text, privateTokens, `Private channel/facade: ${name}`);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

export function auditBundle(feature, metadata, code) {
  const inputs = Object.keys(metadata.inputs ?? {});
  assert.ok(
    inputs.includes(`${featureRoot(feature)}src/main.ts`),
    "Original feature entry missing",
  );
  assert.ok(inputs.includes(sdkEntry), "Bundled public SDK missing");
  for (const input of inputs) classifyInput(feature, input);
  const outputs = Object.values(metadata.outputs ?? {});
  assert.ok(outputs.length > 0, "Bundle outputs missing");
  for (const section of Object.values(metadata.inputs))
    for (const imported of section.imports ?? []) {
      assert.notEqual(imported.kind, "dynamic-import", "Dynamic input dependency");
      // esbuild records erased `import { type T }` as external in inputs.
      // Actual outputs must still contain ONLY the approved crypto external.
      if (imported.external)
        assert.ok(
          ["node:crypto", "@kobrixa/plugin-sdk", "@kobrixa/plugin-protocol"].includes(
            imported.path,
          ),
          `Input external: ${imported.path}`,
        );
    }
  for (const section of outputs)
    for (const imported of section.imports ?? []) {
      assert.notEqual(imported.kind, "dynamic-import", "Dynamic runtime dependency");
      if (imported.external)
        assert.equal(imported.path, "node:crypto", `Runtime external: ${imported.path}`);
    }
  assert.ok(code.trim().length > 1000, "Empty feature bundle");
  assert.doesNotMatch(code, privateTokens, "Private/retired symbol in feature bundle");
}

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlink in audited tree: ${file}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files.sort();
}

// Builds in memory: does not overwrite packaging output or any other work package.
export async function auditFeature(feature) {
  const base = featureRoot(feature);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`${base}src/main.ts`],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    alias: {
      "@kobrixa/plugin-sdk": path.join(root, sdkEntry),
      "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
    },
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text,
    metadata = result.metafile;
  auditBundle(feature, metadata, code);
  const inputs = new Set(Object.keys(metadata.inputs));
  // Type-only/dead imports must also be audited, even if the bundler erases them.
  for (const directory of [
    `${base}src`,
    "packages/plugin-sdk-js/src",
    "packages/plugin-protocol/src",
  ])
    for (const file of await filesUnder(path.join(root, directory)))
      if (/\.[cm]?tsx?$/.test(file) && !/\.(?:test|spec)\./.test(file))
        inputs.add(normalize(path.relative(root, file)));
  const sources = {};
  for (const file of inputs) {
    if (classifyInput(feature, file) === "public-schema-dependency") continue;
    const source = await readFile(path.join(root, file), "utf8");
    auditSource(feature, source, file);
    sources[file] = digest(source);
  }
  return {
    feature,
    metadata,
    code,
    sources,
    bundleSha256: digest(code),
    scope: "current-source in-memory build; not a shipped artifact or native observation",
  };
}

const commonRpc = [
  "devices/negotiate",
  "devices/list",
  "devices/session",
  "devices/context",
  "devices/read",
  "devices/subscribe",
  "events/ack",
  "events/unsubscribe",
  "ui/instances",
  "ui/state",
  "ui/subscribe",
  "ui/snapshot",
  "ui/patch",
  "ui/formPatch",
  "ui/showMessage",
  "ui/dataBegin",
  "ui/dataChunk",
  "ui/dataCommit",
  "ui/dataAbort",
  "ui/dataRead",
  "ui/dataSnapshot",
];
export const rpcPolicy = {
  "sensor-lab": {
    allowed: [
      ...commonRpc,
      "devices/recording/reserve",
      "devices/recording/query",
      "devices/recording/read",
      "devices/recording/release",
      "storage/beginWrite",
      "storage/writeChunk",
      "storage/sealWrite",
      "storage/commitWrite",
      "storage/writeStatus",
      "storage/abortWrite",
      "storage/stat",
      "storage/list",
      "storage/openRead",
      "storage/readChunk",
      "storage/closeRead",
      "storage/delete",
      "storage/flush",
      "storage/quota",
      "storage/registerCheckpoint",
      "storage/abandonCheckpoint",
      "storage/exportBegin",
      "storage/exportChunk",
      "storage/exportCommit",
      "storage/exportStatus",
      "storage/exportCancel",
      "ui/copyText",
    ],
    required: [
      "devices/negotiate",
      "devices/list",
      "ui/instances",
      "ui/subscribe",
      "ui/patch",
      "ui/dataCommit",
      "devices/recording/reserve",
      "devices/recording/read",
      "storage/registerCheckpoint",
      "storage/beginWrite",
      "storage/writeChunk",
      "storage/commitWrite",
      "storage/stat",
      "storage/list",
      "storage/openRead",
      "storage/readChunk",
    ],
  },
  "device-ev3": {
    allowed: [
      ...commonRpc,
      "devices/discover",
      "devices/connect",
      "devices/inputModes/query",
      "devices/inputModes/set",
      "devices/connectionRecovery/read",
      "settings/read",
      "settings/watch",
      "settings/update",
    ],
    required: [
      "devices/negotiate",
      "devices/list",
      "devices/discover",
      "devices/connect",
      "devices/session",
      "devices/read",
      "devices/inputModes/query",
      "devices/inputModes/set",
      "devices/connectionRecovery/read",
      "ui/instances",
      "ui/subscribe",
      "ui/patch",
      "settings/read",
      "settings/watch",
    ],
  },
};
const hostMethods = new Set([
  "initialize",
  "initialized",
  "shutdown",
  "exit",
  "command/invoke",
  "ui/negotiate",
  "ui/ready",
  "events/deliver",
  "storage/drain",
  "$/cancelRequest",
]);

// Only observed, owner-correlated successful request/reply pairs satisfy coverage.
// Sample transcripts in the unit tests are validator fixtures, never acceptance.
function inspectWire(feature, wire) {
  featureRoot(feature);
  assert.ok(Array.isArray(wire) && wire.length > 0, "Actual RPC transcript required");
  const owner = wire[0].owner;
  assert.equal(owner?.pluginId, `kobrixa.${feature}`);
  assert.equal(owner.sourceKey, `builtin:kobrixa.${feature}`);
  for (const key of ["hostEpoch", "processEpoch"])
    assert.ok(typeof owner[key] === "string" && owner[key].length > 0, `Missing owner ${key}`);
  assert.ok(Number.isSafeInteger(owner.generation) && owner.generation >= 0);
  let sequence = -1;
  const pending = new Map(),
    successful = new Set(),
    observed = new Set();
  for (const row of wire) {
    assert.ok(
      Number.isSafeInteger(row.sequence) && row.sequence > sequence,
      "Wire order missing/replayed",
    );
    sequence = row.sequence;
    assert.deepEqual(row.owner, owner, "Stale/replacement owner on wire");
    assert.ok(["plugin-host", "host-plugin"].includes(row.direction), "Unknown wire direction");
    const message = row.message;
    assert.equal(message?.jsonrpc, "2.0");
    if (message.method) {
      if (message.method === "$/cancelRequest") {
        assert.equal(message.id, undefined, "Cancellation is a notification");
        assert.ok(
          pending.has(`${row.direction}:${JSON.stringify(message.params?.id)}`),
          "Cancellation without original request",
        );
      } else if (row.direction === "plugin-host") {
        assert.ok(
          rpcPolicy[feature].allowed.includes(message.method),
          `Forbidden RPC: ${message.method}`,
        );
        observed.add(message.method);
      } else assert.ok(hostMethods.has(message.method), `Forbidden host RPC: ${message.method}`);
      if (message.id !== undefined) {
        const key = `${row.direction}:${JSON.stringify(message.id)}`;
        assert.ok(!pending.has(key), "Duplicate request ID");
        pending.set(key, { method: message.method, answered: false });
      }
    } else {
      const reverse = row.direction === "host-plugin" ? "plugin-host" : "host-plugin";
      const request = pending.get(`${reverse}:${JSON.stringify(message.id)}`);
      assert.ok(request && !request.answered, "Unmatched/duplicate original response");
      request.answered = true;
      if (reverse === "plugin-host" && message.result?.ok === true) successful.add(request.method);
    }
  }
  return { observed: [...observed].sort(), successful };
}

export function auditTrace(feature, wire) {
  const result = inspectWire(feature, wire);
  for (const method of rpcPolicy[feature].required)
    assert.ok(result.successful.has(method), `Missing successful observed RPC: ${method}`);
  return result.observed;
}

// Installed Lab intentionally closes then explicitly reopens a fresh generation.
// Audit every generation, but never combine them to manufacture original-owner
// coverage. The existing installed oracle checks the lifecycle ordering too.
export function auditLaunchedTrace(feature, report) {
  const owners = report.launches.map((launch) => launch.owner);
  assert.ok(owners.length > 0);
  for (let i = 0; i < owners.length; i++)
    assert.ok(
      !owners.slice(0, i).some((owner) => isDeepStrictEqual(owner, owners[i])),
      "Repeated launch owner",
    );
  let sequence = -1;
  for (const row of report.wire) {
    assert.ok(row.sequence > sequence, "Global wire order missing/replayed");
    sequence = row.sequence;
    assert.ok(
      owners.some((owner) => isDeepStrictEqual(owner, row.owner)),
      "Unlaunched wire owner",
    );
  }
  return owners.map((owner, i) => {
    const wire = report.wire.filter((row) => isDeepStrictEqual(row.owner, owner));
    return {
      owner,
      methods: i === 0 ? auditTrace(feature, wire) : inspectWire(feature, wire).observed,
    };
  });
}

// Core files/deployment/Stop/Disconnect remain intentional. The consumer may
// NEVER call these IPC channels; this list applies only to the whole product.
export const retainedCoreChannels = new Set([
  "device:event",
  "device:files",
  "device:files-prepare",
  "device:files-execute",
  "device:files-renew",
  "device:files-stop",
  "device:upload",
  "device:deploy",
  "device:run",
  "device:stop",
  "device:delete",
  "device:disconnect",
]);
const retired = {
  "sensor-lab":
    /\b(?:SensorLabService|SensorLabController|SensorLabPanel|RecordingStatus)\b|sensor-lab:/,
  "device-ev3":
    /\b(?:MonitorPanel|MonitorWorkspace)\b|device:(?:connect(?:-wifi)?|discover|preferences|set-preferences|input-modes|set-input-mode|monitor|watch-monitor|monitor-update)(?![a-z-])/,
};
export function auditRetiredText(feature, text, filename) {
  featureRoot(feature);
  assert.doesNotMatch(text, retired[feature], `Retired feature in ${filename}`);
  if (feature === "device-ev3")
    for (const [channel] of text.matchAll(/\bdevice:[a-z-]+/g))
      assert.ok(
        retainedCoreChannels.has(channel),
        `Uninventoried core channel ${channel}: ${filename}`,
      );
}
// W07a/W07b retained-core exceptions, never permissions for plugin consumers.
// Each entry names one consumer; sites are its exact host/preload wiring (or
// saved-tab mount). Token fingerprints ignore comments/formatting but deliberately
// fail closed on behavior changes, including renamed/aliased feature operations.
// Updating a fingerprint requires reviewing the retained-core contract again.
export const retainedCoreAllowlist = [
  {
    token: "device:watch-monitor",
    justification: "Core battery demand uses the existing host broker, with no feature sampler.",
    consumer: {
      file: "apps/desktop/src/renderer/device/monitor-controller.ts",
      symbol: "CoreBatteryMonitor",
      sha256: "a9d7c3a82f0f51d2f894d13e92806e44db0c5c2e201635282724968f2c190b32",
    },
    sites: [
      {
        file: "apps/desktop/src/main/ipc.ts",
        sha256: "039e66efc8e27e6671d2555a7e973b8130d4dedd0a0473b877e126e639d91e2e",
        count: 1,
      },
      {
        file: "apps/desktop/src/preload/index.ts",
        sha256: "2702cab7c5b3a3d322cc046c548cb68c163783effb961bb94bc8ad968cc77f0c",
        count: 1,
      },
    ],
  },
  {
    token: "device:monitor-update",
    justification:
      "Core battery status observes the same broker feed and reads only battery fields.",
    consumer: {
      file: "apps/desktop/src/renderer/device/battery-status.ts",
      symbol: "BatteryStatus",
      sha256: "bc28ce643541fda7df9f606693fe3760180f58e7898f9be0f627646339636015",
    },
    sites: [
      {
        file: "apps/desktop/src/main/index.ts",
        sha256: "e72fd661800db6430c969629ea99b30135a207f29084f3f8b61c247072634da9",
        count: 1,
      },
      {
        file: "apps/desktop/src/preload/index.ts",
        sha256: "ac0b8d9efc15417754d9373d4786badecac0abe63fefbe346befa369041f7345",
        count: 1,
      },
      {
        file: "apps/desktop/src/preload/index.ts",
        sha256: "5b03981b686f158daf93d870c7d23c9c3bdc66a7d77dc04f43ef6cd1f2652805",
        count: 1,
      },
    ],
  },
  {
    token: "MonitorWorkspace",
    justification:
      "Saved Monitor tabs redirect to public plugin panels without mounting retired controls.",
    consumer: {
      file: "apps/desktop/src/renderer/device/monitor-workspace.tsx",
      symbol: "MonitorWorkspace",
      sha256: "c7c6f4d7a0da423b3cc8b86119703dc0bfebf7e9f5153f2d6426e1827634c5ee",
    },
    sites: [
      {
        file: "apps/desktop/src/renderer/app.tsx",
        sha256: "aeae24ba0233f89a0e133e94ae04d1f8c37579cee9c9299eb3bbea596b1ee0c7",
        count: 1,
      },
      {
        file: "apps/desktop/src/renderer/app.tsx",
        sha256: "f0a23b583e4ebdcc5b6562efa73765285b86fc72c2e013121a756da25a3ca137",
        count: 1,
      },
      {
        file: "apps/desktop/src/renderer/device/monitor-workspace.tsx",
        sha256: "8d77c88b95e1467d024324661f1d5428b66c5e3b1c0bb86f5b2311e793f592d4",
        count: 1,
      },
    ],
  },
];

function coreFingerprint(node) {
  const tokens = [];
  function visit(current) {
    const children = current.getChildren();
    if (!children.length && current.kind !== ts.SyntaxKind.EndOfFileToken)
      tokens.push([current.kind, current.getText()]);
    else children.forEach(visit);
  }
  visit(node);
  return digest(JSON.stringify(tokens));
}
function retainedScope(node) {
  for (let current = node.parent; current; current = current.parent)
    if (
      ts.isPropertyAssignment(current) ||
      ts.isExpressionStatement(current) ||
      ts.isVariableStatement(current) ||
      ts.isImportDeclaration(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isFunctionDeclaration(current)
    )
      return current;
  assert.fail("Retained item outside permitted wiring");
}

// In-memory seam for adversarial tests: exactly the same inventory and checks as
// the disk audit. Fixture code is still scanned for retired tokens. Only facade
// consumer counting uses the reachable production graph (legacy oracles are not
// mounted consumers); importing an oracle into production makes it count again.
export function auditRetiredSources(feature, sources) {
  featureRoot(feature);
  const trees = new Map(
    Object.entries(sources).map(([file, source]) => {
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      assert.equal(tree.parseDiagnostics.length, 0, `Unparseable source: ${file}`);
      return [normalize(file), tree];
    }),
  );
  const reachable = new Set();
  function reach(file) {
    if (reachable.has(file) || !trees.has(file)) return;
    reachable.add(file);
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith(".")) {
          const target = normalize(path.posix.join(path.posix.dirname(file), specifier));
          for (const candidate of [
            target,
            target.replace(/\.js$/, ".ts"),
            target.replace(/\.js$/, ".tsx"),
            `${target}.ts`,
            `${target}.tsx`,
            `${target}/index.ts`,
          ])
            reach(candidate);
        }
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = node.arguments[0];
        assert.ok(
          specifier && ts.isStringLiteralLike(specifier),
          `Nonliteral production import: ${file}`,
        );
        const target = normalize(path.posix.join(path.posix.dirname(file), specifier.text));
        for (const candidate of [
          target,
          target.replace(/\.js$/, ".ts"),
          target.replace(/\.js$/, ".tsx"),
        ])
          reach(candidate);
      }
      ts.forEachChild(node, visit);
    }
    visit(trees.get(file));
  }
  for (const entry of ["main/index.ts", "preload/index.ts", "renderer/app.tsx"])
    reach(`apps/desktop/src/${entry}`);
  const seen = new Map();
  const facadeCounts = new Map();
  // The independent historical oracle is not a product consumer. It remains
  // scanned above for retired channels and may never enter the production graph.
  const oracle = "apps/desktop/src/renderer/device/legacy-monitor.fixture.ts";
  const facadeInventory = {
    watchMonitor: {
      "preload/index.ts": 1,
      "shared/api.ts": 1,
      "renderer/device/monitor-controller.ts": 3,
    },
    onMonitor: {
      "preload/index.ts": 1,
      "shared/api.ts": 1,
      "renderer/device/monitor-controller.ts": 1,
      "renderer/device/battery-status.ts": 2,
    },
  };
  for (const [file, tree] of trees) {
    function visit(node) {
      if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
        const entry =
          feature === "device-ev3" &&
          retainedCoreAllowlist.find((item) => item.token === node.text);
        if (entry) {
          const hash = coreFingerprint(retainedScope(node));
          const site = entry.sites.find((item) => item.file === file && item.sha256 === hash);
          assert.ok(site, `Unapproved retained-core use ${entry.token}: ${file}`);
          seen.set(site, (seen.get(site) ?? 0) + 1);
          assert.ok(
            seen.get(site) <= site.count,
            `Second retained-core consumer ${entry.token}: ${file}`,
          );
        } else auditRetiredText(feature, node.text, file);
        // Include property access, bracket access, destructuring and string keys;
        // declarations in the shared contract/preload and the core type Pick are
        // inventory, not extra consumers. No other reachable file may use them.
        if (
          feature === "device-ev3" &&
          ["watchMonitor", "onMonitor"].includes(node.text) &&
          (file !== oracle || reachable.has(file))
        ) {
          const expected = facadeInventory[node.text][file.replace("apps/desktop/src/", "")];
          const key = `${file}:${node.text}`;
          facadeCounts.set(key, (facadeCounts.get(key) ?? 0) + 1);
          assert.ok(
            expected && facadeCounts.get(key) <= expected,
            `Second retained-core consumer ${node.text}: ${file}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  if (feature === "device-ev3")
    for (const entry of retainedCoreAllowlist) {
      for (const site of entry.sites)
        assert.equal(
          seen.get(site) ?? 0,
          site.count,
          `Stale retained-core allowlist ${entry.token}: ${site.file}`,
        );
      const tree = trees.get(entry.consumer.file);
      assert.ok(tree, `Stale retained-core consumer ${entry.consumer.symbol}`);
      assert.equal(
        coreFingerprint(tree),
        entry.consumer.sha256,
        `Changed retained-core consumer ${entry.consumer.symbol}: feature behavior requires review`,
      );
      assert.ok(
        reachable.has(entry.consumer.file),
        `Stale unreachable core consumer ${entry.consumer.symbol}`,
      );
    }
  assert.ok(trees.size > 0);
  return [...trees.keys()];
}
export async function auditRetiredSource(feature) {
  const sources = {};
  for (const area of ["main", "preload", "renderer", "shared"])
    for (const file of await filesUnder(path.join(root, "apps/desktop/src", area))) {
      if (!/\.[cm]?tsx?$/.test(file) || /\.(?:test|spec)\./.test(file)) continue;
      sources[normalize(path.relative(root, file))] = await readFile(file, "utf8");
    }
  return auditRetiredSources(feature, sources);
}

// The map is build metadata, not independent attestation. Bind its source bytes
// to this checkout and inspect the ACTUAL leaf for all runtime imports as well.
export async function auditProductionLeaf(
  feature,
  leaf,
  sourceMap = path.join(leaf, "main.cjs.map"),
) {
  const index = await verifyLeaf(leaf, `kobrixa.${feature}`);
  const code = await readFile(path.join(leaf, "main.cjs"), "utf8");
  auditRuntimeCode(code);
  assert.equal(path.basename(sourceMap), "main.cjs.map", "Original production map required");
  assert.equal(
    digest(await readFile(path.join(path.dirname(sourceMap), "main.cjs"))),
    digest(code),
    "Source map must accompany the same production bytes",
  );
  const mapBytes = await readFile(sourceMap),
    map = JSON.parse(mapBytes);
  assert.equal(map.version, 3);
  assert.ok(
    Array.isArray(map.sources) &&
      map.sources.length > 0 &&
      map.sourcesContent?.length === map.sources.length,
    "Production source metadata required",
  );
  assert.equal(map.file, "main.cjs");
  const sourceHashes = {};
  for (let i = 0; i < map.sources.length; i++) {
    const name = normalize(
      path.relative(
        root,
        path.resolve(path.dirname(sourceMap), map.sourceRoot ?? "", map.sources[i]),
      ),
    );
    const kind = classifyInput(feature, name);
    assert.equal(typeof map.sourcesContent[i], "string", `Missing source bytes: ${name}`);
    const bytes = await readFile(path.join(root, name), "utf8");
    assert.equal(digest(bytes), digest(map.sourcesContent[i]), `Stale production source: ${name}`);
    if (kind !== "public-schema-dependency") auditSource(feature, bytes, name);
    sourceHashes[name] = digest(bytes);
  }
  assert.ok(
    sourceHashes[`${featureRoot(feature)}src/main.ts`] && sourceHashes[sdkEntry],
    "Feature/SDK absent from production metadata",
  );
  const closure = await build({
    entryPoints: [path.join(leaf, "main.cjs")],
    bundle: true,
    write: false,
    platform: "node",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "stage3-runtime-closure",
        setup(context) {
          context.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return;
            assert.equal(
              args.path,
              "node:crypto",
              `Forbidden production runtime external: ${args.path}`,
            );
            assert.notEqual(args.kind, "dynamic-import", "Dynamic production import");
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  return {
    index,
    bundleSha256: digest(code),
    sourceMapSha256: digest(mapBytes),
    sourceHashes,
    metadata: closure.metafile,
  };
}

export function auditRuntimeCode(code) {
  assert.doesNotMatch(code, privateTokens, "Private symbol in shipped leaf");
  // esbuild leaves computed require/import unresolved; reject those explicitly.
  const tree = ts.createSourceFile(
    "main.cjs",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function visit(node) {
    if (ts.isIdentifier(node) && node.text === "require")
      assert.ok(
        ts.isCallExpression(node.parent) && node.parent.expression === node,
        "Aliased runtime loader",
      );
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(tree) === "require")
    ) {
      assert.notEqual(
        node.expression.kind,
        ts.SyntaxKind.ImportKeyword,
        "Dynamic production import",
      );
      assert.ok(
        node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]) &&
          node.arguments[0].text === "node:crypto",
        "Computed/private runtime load",
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

export async function auditInstalledTrace(feature, directory, production) {
  const bytes = await readFile(path.join(directory, "installed.json"));
  const receipt = JSON.parse(bytes),
    identity = receipt.identity;
  assert.deepEqual(
    identity.productArtifact.index,
    production.index,
    "Transcript used a different production leaf",
  );
  assert.ok(identity.claim, "Acceptance-host scope must remain explicit");
  for (const [file, hash] of Object.entries(identity.sourceHashes))
    assert.equal(
      digest(await readFile(path.resolve(root, file))),
      hash,
      `Stale native source: ${file}`,
    );
  for (const [file, hash] of Object.entries(identity.artifactHashes))
    assert.equal(
      digest(await readFile(path.join(directory, file))),
      hash,
      `Changed native artifact: ${file}`,
    );
  const healthy = receipt.receipts.filter((r) => r.scenario === "healthy");
  assert.equal(healthy.length, 1);
  const producerBytes = await readFile(path.join(directory, "healthy/producer.json"));
  assert.equal(
    digest(producerBytes),
    healthy[0].producerSha256,
    "Producer differs from executed receipt",
  );
  const report = JSON.parse(producerBytes);
  assert.equal(report.scenario, "healthy");
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.ok(report.launches.length > 0, "Original plugin launch missing");
  for (const launch of report.launches)
    assert.equal(launch.sha256, production.bundleSha256, "Observed process loaded different bytes");
  const generations = auditLaunchedTrace(feature, report);
  // Reuse the independent installed behavioral oracle; a method-name list is
  // insufficient to claim the feature actually worked.
  const module = await import(
    feature === "sensor-lab" ? "./sensor-lab-installed-run.mjs" : "./device-ui-installed-run.mjs"
  );
  const verify =
    feature === "sensor-lab" ? module.verifyInstalledReceipt : module.verifyInstalledDeviceReceipt;
  assert.equal(typeof verify, "function", "Installed oracle unavailable");
  verify(report);
  return {
    generations,
    receiptSha256: digest(bytes),
    producerSha256: digest(producerBytes),
    scope: identity.claim,
  };
}

export async function auditProduct(feature, productRoot) {
  const files = await filesUnder(productRoot),
    hashes = {};
  assert.ok(
    files.some((f) => /(?:^|[/\\])preload\.cjs$/.test(f)),
    "Full unpacked product preload required",
  );
  assert.ok(
    files.some(
      (f) => /(?:^|[/\\])main\.(?:c?js)$/.test(f) && !f.includes(`${path.sep}plugins${path.sep}`),
    ),
    "Full product main required",
  );
  assert.ok(
    files.some((f) => f.includes(`${path.sep}renderer${path.sep}`) && f.endsWith(".js")),
    "Full product renderer required",
  );
  for (const file of files) {
    if (!/\.(?:[cm]?js|map)$/.test(file) || file.includes(`${path.sep}node_modules${path.sep}`))
      continue;
    const bytes = await readFile(file);
    auditRetiredText(feature, bytes.toString("utf8"), file);
    hashes[normalize(path.relative(productRoot, file))] = digest(bytes);
  }
  return hashes;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      ["--feature", "--leaf", "--source-map", "--receipt-dir", "--product-root"].includes(
        args[i],
      ) &&
        args[i + 1] &&
        !options[args[i]],
      "Usage: --feature sensor-lab|device-ev3 --leaf ABS --receipt-dir ABS --product-root ABS [--source-map ABS]",
    );
    options[args[i]] = args[i + 1];
  }
  const feature = options["--feature"];
  for (const key of ["--leaf", "--receipt-dir", "--product-root"])
    assert.ok(options[key] && path.isAbsolute(options[key]), `Absolute ${key} required`);
  const source = await auditFeature(feature);
  await auditRetiredSource(feature);
  const production = await auditProductionLeaf(feature, options["--leaf"], options["--source-map"]);
  const trace = await auditInstalledTrace(feature, options["--receipt-dir"], production);
  const product = await auditProduct(feature, options["--product-root"]);
  assert.equal(
    product[`plugins/${feature}/main.cjs`] ?? product[`.vite/build/plugins/${feature}/main.cjs`],
    production.bundleSha256,
    "Audited leaf must belong to the audited product",
  );
  console.log(
    JSON.stringify(
      {
        feature,
        sourceHashes: source.sources,
        production,
        trace,
        product,
        scope:
          "source + production bytes + installed acceptance-host RPC; whole-product behavior and hardware remain separate",
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
