import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

import { processTable, descendants } from "./builtin-installed-client.mjs";
import { createProcessMonitor, finishProcessObservation } from "./device-ui-stdio-run.mjs";
import { copyInstalledLeaf } from "./sensor-lab-installed-artifacts.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dependencies = process.env.KOBRIXA_E6_DEPS ?? root;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pluginId = "kobrixa.device-ev3";
export const legacyDevice = {
  skipUnchangedAssets: true,
  usbAutoReconnect: false,
  usbRetryInterval: 2000,
  usbRetryLimit: 3,
  wifiConnectTimeout: 10000,
  wifiHandshakeTimeout: 5000,
};
const ok = (result) => {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result.value;
};

// Structural/correlation oracle, not a cryptographic attestation against a malicious producer.
// Every required action must have its original successful RPC reply and correct owner.
export function verifyDeviceReceipt(report, { installed = false } = {}) {
  assert.equal(report.schema, 1);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.ok(report.versions.electron);
  assert.equal(report.launches.length, 1);
  assert.equal(report.exits.length, 1);
  const owner = report.launches[0].owner;
  assert.equal(owner.pluginId, pluginId);
  assert.equal(owner.sourceKey, `builtin:${pluginId}`);
  for (const key of ["hostEpoch", "processEpoch"]) assert.match(owner[key], /^[0-9a-f-]{36}$/);
  assert.ok(Number.isInteger(owner.generation));
  assert.deepEqual(report.exits[0].owner, owner);
  let processId;
  if (installed) {
    const launch = report.launches[0],
      observed = launch.processObservation;
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
    assert.equal(launch.parentPid, report.mainPid);
    assert.equal(observed.pid, launch.pid);
    assert.equal(observed.forkPid, launch.pid);
    assert.equal(observed.method, "utilityProcess.fork");
    assert.equal(observed.ppid, report.mainPid);
    assert.equal(observed.serviceName, "Kobrixa plugin " + pluginId);
    assert.equal(report.exits[0].exit.code, 0);
    assert.ok(!report.exits[0].exit.reason);
    processId = launch.pid;
  } else {
    const pid = report.logs.map((line) => /DEVICE_PID:(\d+)/.exec(line)).find(Boolean);
    assert.ok(pid, "Actual utility process PID output missing");
    processId = Number(pid[1]);
  }
  assert.notEqual(processId, report.mainPid);
  assert.ok(processId > 0);
  let sequence = 0;
  for (const row of report.wire) {
    assert.ok(row.sequence > sequence);
    sequence = row.sequence;
    assert.deepEqual(row.owner, owner);
  }
  const pairs = (method, direction = "plugin-host", allowFailure = false) =>
    report.wire
      .filter((row) => row.direction === direction && row.message.method === method)
      .map((request) => {
        const replies = report.wire.filter(
          (row) =>
            row.sequence > request.sequence &&
            row.direction !== direction &&
            row.message.id === request.message.id &&
            !row.message.method,
        );
        assert.equal(replies.length, 1, `Original reply ${method}`);
        return {
          request,
          response: replies[0],
          value:
            allowFailure && replies[0].message.result?.ok === false
              ? null
              : ok(replies[0].message.result),
        };
      });
  const cp = report.checkpoints;
  let previous = 0;
  for (const name of [
    "migrated",
    "opened",
    "reopened",
    "read",
    "mode",
    "updated",
    "reset",
    "hiding",
    "hidden",
    "disabled",
    "reenabled",
  ]) {
    assert.ok(cp[name]?.at > previous, `Ordered checkpoint ${name}`);
    previous = cp[name].at;
  }
  assert.equal(cp.migrated.launches, 0);
  assert.equal(cp.migrated.settings.state, "ready");
  assert.deepEqual(cp.migrated.settings.values, {
    ...legacyDevice,
    connectionMode: "usb",
    rememberWifiAddress: true,
    lastWifiAddress: " 192.0.2.9 ",
  });
  for (const phase of ["constructed-frozen", "gate-freeze", "gate-settled"]) {
    const row = report.gate.find((row) => row.phase === phase);
    assert.ok(row && row.at <= cp.migrated.at, phase);
  }
  const capture = report.ipc.find((row) => row.channel === "persistence:legacy-preferences-submit");
  assert.ok(capture && capture.at < cp.migrated.at);
  const seed = report.legacyAudit.filter((row) => row.kind === "seed");
  assert.equal(seed.length, 1, "Original legacy seed evidence");
  assert.ok(seed[0].at < capture.at);
  assert.deepEqual(seed[0].entries, capture.args[0].entries, "Original raw bytes reached capture");
  assert.deepEqual(
    report.legacyAudit.filter((row) => row.kind === "write"),
    [],
    "Legacy writer must be frozen before bootstrap writes",
  );
  assert.ok(["accepted", "reconciled"].includes(capture.result?.state));
  assert.equal(report.navigation.length, 1, "Exactly one original document navigation");
  const document = report.navigation[0];
  assert.equal(document.error, undefined);
  assert.equal(document.previous.hostEpoch, document.next.hostEpoch);
  assert.equal(document.next.hostEpoch, owner.hostEpoch);
  assert.notEqual(
    document.previous.workbenchInstance,
    document.next.workbenchInstance,
    "Navigation must retire the original scope",
  );
  assert.deepEqual(document.committed, document.next);
  assert.ok(document.at <= document.committedAt && document.committedAt < capture.at);
  assert.ok(document.retiredAt >= document.at && document.retiredAt < cp.migrated.at);
  assert.deepEqual(
    capture.args[0].scope,
    document.committed,
    "Capture belongs to committed document",
  );

  assert.deepEqual(capture.args[0].entries, [
    { key: "kobrixa.connectionMode", raw: "usb" },
    { key: "kobrixa.rememberWifiAddress", raw: "true" },
    { key: "kobrixa.lastWifiAddress", raw: " 192.0.2.9 " },
  ]);
  for (const method of ["devices/discover", "devices/connect"]) {
    const rows = pairs(method);
    assert.equal(rows.length, 1, `${method} no replay`);
    assert.ok(rows[0].request.at > cp.reopened.at, "Readonly open/reopen");
  }
  for (const method of [
    "devices/read",
    "devices/inputModes/query",
    "devices/inputModes/set",
    "devices/subscribe",
    "settings/read",
    "settings/watch",
  ])
    assert.ok(pairs(method).length, method);
  const subscriptions = pairs("devices/subscribe");
  const removals = pairs("events/unsubscribe", "plugin-host", true);
  const ids = subscriptions.map((row) => row.value.subscriptionId);
  assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
  assert.equal(new Set(ids).size, ids.length, "Distinct device subscription identities");
  assert.ok(cp.hiding.sequence < cp.hidden.sequence);
  const active = subscriptions.filter(
    (row) =>
      row.response.sequence <= cp.hiding.sequence &&
      !removals.some(
        (end) =>
          end.request.message.params.subscriptionId === row.value.subscriptionId &&
          end.value?.removed === true &&
          end.response.sequence <= cp.hiding.sequence,
      ),
  );
  assert.ok(active.length > 0, "Live device observers before hide");
  for (const subscription of active) {
    const closed = removals.filter(
      (row) =>
        row.request.message.params.subscriptionId === subscription.value.subscriptionId &&
        row.request.sequence > cp.hiding.sequence &&
        row.response.sequence <= cp.hidden.sequence &&
        row.request.at > cp.hiding.at &&
        row.response.at <= cp.hidden.at &&
        row.value?.removed === true,
    );
    assert.equal(closed.length, 1, "Original active observer disposed by hide");
  }
  const commands = pairs("command/invoke", "host-plugin");
  const specifications = [
    ["discover", "discover-action", "devices/discover"],
    ["candidate", "candidates", "devices/connect"],
    ["refresh", "refresh-action", "devices/read"],
    ["modes", "modes-action", "devices/inputModes/query"],
    ["mode", "modes", "devices/inputModes/set"],
  ];
  const used = new Set();
  let previousInput = -Infinity;
  for (const [index, [command, node, operation]] of specifications.entries()) {
    const rows = commands.filter(
      (row) => row.request.message.params.command === `${pluginId}.${command}`,
    );
    assert.equal(rows.length, 1, command);
    const invocation = rows[0],
      params = invocation.request.message.params;
    assert.equal(params.context.origin, "panel");
    assert.ok(params.context.binding);
    assert.deepEqual(invocation.value.fieldErrors, []);
    const attempts = report.inputs.filter((input) => input.command === command);
    assert.equal(attempts.length, 1, `One driver action ${command}`);
    const input = attempts[0],
      rowAction = command === "candidate" || command === "mode";
    assert.equal(
      input.selector,
      rowAction ? `[data-ui-node="${node}"] tbody tr button` : `[data-ui-node="${node}"] button`,
    );
    assert.equal(input.target.node, node);
    assert.ok(input.at > previousInput);
    assert.deepEqual(input.binding, params.context.binding);
    const interactions = report.ipc.filter(
      (row) =>
        row.channel === "plugins:ui:interact" &&
        row.result?.ok &&
        row.result.value.invocationId === params.invocationId,
    );
    assert.equal(interactions.length, 1, `Original trusted admission ${command}`);
    const interaction = interactions[0],
      action = interaction.args[0];
    assert.equal(action.nodeId, node);
    assert.equal(action.kind, rowAction ? "row" : "action");
    assert.deepEqual(action.binding, params.context.binding);
    assert.ok(input.at < interaction.at && interaction.at <= invocation.request.at);
    assert.ok(interaction.finishedAt >= invocation.response.at);
    const downs = report.native.filter(
      (event) =>
        event.isTrusted &&
        event.type === "pointerdown" &&
        event.at >= input.at &&
        event.at < interaction.at &&
        event.node === node &&
        event.targetId === input.target.targetId &&
        event.ariaLabel === input.target.ariaLabel,
    );
    assert.equal(downs.length, 1, `Exact distinct trusted target ${command}`);
    const down = downs[0];
    assert.ok(!used.has(down));
    used.add(down);
    assert.ok(down.at > previousInput);
    const ups = report.native.filter(
      (event) =>
        event.isTrusted &&
        event.type === "pointerup" &&
        event.at > down.at &&
        event.at <= interaction.at &&
        event.node === node &&
        event.targetId === down.targetId &&
        event.ariaLabel === down.ariaLabel,
    );
    assert.equal(ups.length, 1, `Original target release ${command}`);
    previousInput = ups[0].at;
    if (rowAction) {
      assert.equal(down.ariaLabel, `Select: ${params.arguments.key}`);
      assert.equal(action.key, params.arguments.key);
      assert.equal(action.dataset, node);
      assert.equal(action.revision, params.arguments.dataset);
      const pages = report.ipc.filter(
        (row) =>
          row.channel === "plugins:ui:data-read" &&
          row.finishedAt < down.at &&
          row.args[0].dataset === node &&
          row.args[0].revision === params.arguments.dataset &&
          row.result?.ok &&
          JSON.stringify(row.args[0].binding) === JSON.stringify(params.context.binding),
      );
      assert.ok(
        pages.some(
          (page) =>
            page.result.value.revision === params.arguments.dataset &&
            page.result.value.chunk.entries.some(
              (row) => row.key === params.arguments.key && row.version === params.arguments.version,
            ),
        ),
        `Clicked original row key/version/revision ${command}`,
      );
    }
    const nextCommand = specifications[index + 1]?.[0];
    const phaseEnd =
      command === "refresh"
        ? report.inputs.find((input) => input.command === nextCommand)?.at
        : invocation.response.at;
    assert.ok(Number.isFinite(phaseEnd));
    assert.ok(
      pairs(operation).some(
        (row) =>
          row.request.at > invocation.request.at &&
          row.request.sequence > invocation.request.sequence &&
          row.response.at <= phaseEnd,
      ),
      `Operation belongs to explicit ${command} invocation/phase`,
    );
  }
  const ipc = (channel) =>
    report.ipc.filter((row) => row.channel === `plugins:settings:${channel}`);
  for (const method of ["open", "watch", "unwatch"]) assert.ok(ipc(method).length, method);
  const update = ipc("update");
  const reset = ipc("reset");
  assert.equal(update.length, 1);
  assert.equal(reset.length, 1);
  for (const row of [...update, ...reset]) {
    ok(row.result);
    assert.ok(row.args[1].expectedRevision);
  }
  assert.deepEqual(update[0].args[1].changes, [{ key: "skipUnchangedAssets", value: false }]);
  assert.deepEqual(reset[0].args[1].keys, ["skipUnchangedAssets"]);
  const updated = ok(update[0].result).snapshot;
  const restored = ok(reset[0].result).snapshot;
  assert.ok(updated.revision && restored.revision);
  assert.notEqual(update[0].args[1].expectedRevision, updated.revision);
  assert.equal(reset[0].args[1].expectedRevision, updated.revision);
  assert.notEqual(restored.revision, updated.revision);
  assert.equal(updated.values.find((row) => row.key === "skipUnchangedAssets").value, false);
  assert.equal(restored.values.find((row) => row.key === "skipUnchangedAssets").value, true);
  assert.equal(cp.updated.settings.values.skipUnchangedAssets, false);
  assert.equal(cp.reset.settings.values.skipUnchangedAssets, true);
  assert.ok(
    report.ipc.some(
      (row) => row.channel === "plugins:settings:changed" && row.direction === "publish",
    ),
    "Actual watch publication",
  );
  assert.equal(cp.reenabled.launches, 1);
  assert.equal(cp.reenabled.settings.state, "ready");
  assert.equal(cp.disabled.settings.state, "unavailable");
  assert.ok(report.exits[0].at <= cp.disabled.at);
  assert.equal(report.cleanup.workers, 0);
  for (const values of [report.cleanup.bridge, report.cleanup.worker])
    for (const value of Object.values(values)) assert.equal(value, 0);
  return { owner, processId, synthetic: true, nativeSteps: commands.length };
}

export async function buildDevice(directory, { productionLeaf } = {}) {
  const require = createRequire(path.join(dependencies, "package.json"));
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const desktopRequire = createRequire(path.join(dependencies, "apps/desktop/package.json"));
  const vite = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
  await mkdir(path.join(directory, "profile"), { recursive: true });
  await mkdir(path.join(directory, "plugins/device-ev3/ui"), { recursive: true });
  await mkdir(path.join(directory, "plugins/device-ev3/settings"), { recursive: true });
  if (!productionLeaf)
    await symlink(
      await realpath(path.join(dependencies, "apps/desktop/node_modules")),
      path.join(directory, "node_modules"),
      "dir",
    );
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, [file]]) => [
      name,
      path.join(root, file),
    ]),
  );
  const common = {
    absWorkingDir: root,
    nodePaths: [
      path.join(dependencies, "node_modules"),
      path.join(dependencies, "apps/desktop/node_modules"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external: ["electron", "node-hid", "usb"],
    plugins: [rawResourcePlugin()],
    metafile: true,
  };
  const inputs = new Set(
    [
      "tests/desktop/device-ui-public-run.mjs",
      "tests/desktop/device-ui-public-test.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
    ].map((file) => path.join(root, file)),
  );
  const bundle = async (name, contents) => {
    const result = await build({
      ...common,
      stdin: { contents, resolveDir: root, loader: "ts" },
      outfile: path.join(directory, name),
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === "<stdin>") continue;
      const absolute = input.startsWith("kobrixa-raw-resource:")
        ? input.slice("kobrixa-raw-resource:".length)
        : path.resolve(root, input);
      assert.ok(
        absolute.startsWith(root + path.sep) || absolute.includes("/node_modules/"),
        `Foreign workspace source ${absolute}`,
      );
      assert.ok(
        !absolute.includes("/node_modules/@kobrixa/"),
        `Workspace dependency fallback ${absolute}`,
      );
      inputs.add(absolute);
    }
    await writeFile(
      path.join(directory, name.replaceAll("/", "-") + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
  };
  await bundle(
    "main.cjs",
    `import {runNativeDevice} from ${JSON.stringify(path.join(root, "tests/desktop/device-ui-public-main.ts"))}; runNativeDevice();`,
  );
  await bundle(
    "persistence-worker.cjs",
    `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))}; runShippedPersistenceWorker();`,
  );
  await bundle(
    "preload.cjs",
    `import ${JSON.stringify(path.join(root, "apps/desktop/src/preload/index.ts"))};`,
  );
  const leaf = path.join(directory, "plugins/device-ev3");
  let files;
  if (productionLeaf) {
    files = (await copyInstalledLeaf(productionLeaf, leaf, pluginId)).files;
    inputs.add(path.join(root, "tests/desktop/sensor-lab-installed-artifacts.mjs"));
  } else {
    await bundle(
      "plugins/device-ev3/main.cjs",
      `console.error("DEVICE_PID:"+process.pid); import ${JSON.stringify(path.join(root, "plugins/device-ev3/src/main.ts"))};`,
    );
    for (const name of ["kobrixa-plugin.json", "ui/panel.json", "settings/preferences.json"]) {
      inputs.add(path.join(root, "plugins/device-ev3", name));
      await cp(path.join(root, "plugins/device-ev3", name), path.join(leaf, name));
    }
    files = [];
    for (const name of [
      "kobrixa-plugin.json",
      "main.cjs",
      "ui/panel.json",
      "settings/preferences.json",
    ].sort()) {
      const bytes = await readFile(path.join(leaf, name));
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(
      path.join(leaf, "resource-index.json"),
      JSON.stringify({ version: 1, pluginId, files }),
    );
  }
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: false,
    base: "./",
    resolve: {
      alias: [
        {
          find: /^monaco-editor$/,
          replacement: path.join(
            dependencies,
            "node_modules/monaco-editor/esm/vs/editor/editor.api.js",
          ),
        },
        {
          find: /^monaco-editor\//,
          replacement: path.join(dependencies, "node_modules/monaco-editor/esm/vs/") + "/",
        },
        ...Object.entries({
          ...alias,
          zod: path.join(dependencies, "node_modules/zod"),
          "@eslint-community/regexpp": path.join(
            dependencies,
            "node_modules/@eslint-community/regexpp",
          ),
          react: path.dirname(desktopRequire.resolve("react/package.json")),
          "react-dom": path.dirname(desktopRequire.resolve("react-dom/package.json")),
        }).map(([find, replacement]) => ({ find, replacement })),
      ],
      dedupe: ["react", "react-dom"],
    },
    plugins: [
      (await import(pathToFileURL(desktopRequire.resolve("@vitejs/plugin-react")).href)).default(),
      {
        name: "actual-device-generic-shell",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "legacy-fixture.js",
            source: `(() => {
                const entries = [{key:"kobrixa.connectionMode",raw:"usb"},{key:"kobrixa.rememberWifiAddress",raw:"true"},{key:"kobrixa.lastWifiAddress",raw:" 192.0.2.9 "}];
                const retained=new URLSearchParams(location.search).get("restart")==="2";
                if(!retained) for (const {key,raw} of entries) localStorage.setItem(key,raw);
                console.log("LEGACY_AUDIT:"+JSON.stringify({kind:retained?"retained":"seed",at:performance.timeOrigin+performance.now(),entries:entries.map(({key})=>({key,raw:localStorage.getItem(key)}))}));
                if(new URLSearchParams(location.search).has("restart")) {
                  const remove=Storage.prototype.removeItem, clear=Storage.prototype.clear;
                  Storage.prototype.removeItem=function(key) {if(this===localStorage && entries.some(row=>row.key===key)) console.log("LEGACY_AUDIT:"+JSON.stringify({kind:"write",operation:"remove",key}));return remove.call(this,key);};
                  Storage.prototype.clear=function() {if(this===localStorage) console.log("LEGACY_AUDIT:"+JSON.stringify({kind:"write",operation:"clear"}));return clear.call(this);};
                }
                const set = Storage.prototype.setItem;
                Storage.prototype.setItem = function(key,value) {
                  if (this === localStorage && entries.some(row=>row.key===key)) console.log("LEGACY_AUDIT:"+JSON.stringify({kind:"write",at:performance.timeOrigin+performance.now(),key,raw:String(value)}));
                  return set.call(this,key,value);
                };
              })();`,
          });
          for (const id of this.getModuleIds()) {
            if (id.startsWith("/") && !id.includes("/node_modules/")) {
              assert.ok(id.startsWith(root + path.sep), `Foreign renderer ${id}`);
              inputs.add(id.split("?")[0]);
            }
          }
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html
              .replace("</head>", '<script src="./legacy-fixture.js"></script></head>')
              .replace(
                'src="/src/renderer/index.tsx"',
                `src="/@fs/${path.join(root, "tests/desktop/device-ui-public-renderer.tsx")}"`,
              ),
        },
      },
    ],
    build: { outDir: path.join(directory, "renderer"), emptyOutDir: true },
  });
  const artifactHashes = {},
    sourceHashes = {};
  for (const name of [
    "main.cjs",
    "persistence-worker.cjs",
    "preload.cjs",
    ...files.map((f) => `plugins/device-ev3/${f.path}`),
    "plugins/device-ev3/resource-index.json",
    ...(await readdir(path.join(directory, "renderer"), { recursive: true }))
      .filter((f) => /\.(html|js|css)$/.test(f))
      .map((f) => `renderer/${f}`),
  ])
    artifactHashes[name] = digest(await readFile(path.join(directory, name)));
  for (const file of [...inputs].sort())
    sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  for (const required of [
    ...(!productionLeaf
      ? ["plugins/device-ev3/src/main.ts", "plugins/device-ev3/src/controller.ts"]
      : []),
    "apps/desktop/src/main/plugins/controller.ts",
    "apps/desktop/src/main/plugins/launchers.ts",
    "apps/desktop/src/main/plugins/persistence/worker.ts",
    "apps/desktop/src/preload/index.ts",
    "apps/desktop/src/renderer/settings/settings-state.ts",
    "apps/desktop/src/renderer/plugin-ui/panel-host.tsx",
  ])
    assert.ok(sourceHashes[required], `Missing production source ${required}`);
  const identity = {
    root,
    dependencies,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    artifactHashes,
    sourceHashes,
  };
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return identity;
}

export async function snapshotRestartProfile(profile) {
  const original = await readFile(path.join(profile, "device-settings.json"));
  const base = path.join(profile, "plugins/persistence-v1/namespaces");
  const matches = [];
  for (const name of await readdir(base)) {
    const file = path.join(base, name, "identity.json");
    const identity = JSON.parse(await readFile(file, "utf8"));
    if (identity.sourceKey === `builtin:${pluginId}`) matches.push(path.join(base, name));
  }
  assert.equal(matches.length, 1);
  const namespace = matches[0],
    hashes = {};
  const read = async (relative) => {
    const file = path.join(namespace, relative),
      stat = await lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024);
    const bytes = await readFile(file);
    hashes[relative] = digest(bytes);
    return { bytes, json: JSON.parse(bytes) };
  };
  const document = async (head, folder) => {
    assert.match(head.object, /^r_[a-zA-Z0-9_-]+\.json$/);
    const loaded = await read(`${folder}/objects/${head.object}`);
    assert.equal(loaded.bytes.length, head.byteLength);
    assert.equal(digest(loaded.bytes), head.sha256);
    return loaded.json;
  };
  const imports = [];
  const files = (await readdir(path.join(namespace, "imports")))
    .filter((f) => f.endsWith(".json"))
    .sort();
  assert.ok(files.length > 0 && files.length <= 32);
  for (const file of files) {
    const head = (await read("imports/" + file)).json;
    imports.push({ key: head.target.key, head, document: await document(head, "imports") });
  }
  const head = (await read("settings/head.json")).json;
  return {
    originalSha256: digest(original),
    settings: { head, document: await document(head, "settings") },
    imports,
    hashes,
  };
}
export function verifyRestartReceipt(r) {
  const { first, second, outside, beforeSecond, afterSecond } = r;
  assert.equal(outside.length, 2);
  for (const [i, p] of [first, second].entries()) {
    assert.equal(p.schema, 1);
    assert.equal(p.stage, "complete");
    assert.equal(p.restartPhase, String(i + 1));
    assert.deepEqual(p.failures, []);
    for (const name of ["launches", "exits", "wire"]) assert.deepEqual(p[name], []);
    assert.ok(Number.isSafeInteger(p.mainPid) && p.mainPid > 0);
    assert.equal(outside[i].pid, p.mainPid);
    assert.equal(outside[i].code, 0);
    assert.equal(outside[i].signal, null);
    assert.equal(outside[i].timedOut, false);
    assert.deepEqual(outside[i].survivors, []);
    assert.equal(p.cleanup.workers, 0);
    for (const counters of [p.cleanup.bridge, p.cleanup.worker]) {
      assert.ok(Object.keys(counters).length);
      for (const value of Object.values(counters)) assert.equal(value, 0);
    }
    assert.equal(p.restart.settings.state, "ready");
    assert.equal(p.restart.settings.values.skipUnchangedAssets, false);
    assert.deepEqual(p.restart.renderer.alerts, []);
    assert.deepEqual(
      p.restart.providerTrace,
      [],
      "No provider work or operation replay across restart",
    );
    assert.equal(p.legacyAudit.length, 1);
    assert.equal(p.legacyAudit[0].kind, i === 0 ? "seed" : "retained");
  }
  assert.notEqual(first.mainPid, second.mainPid);
  assert.equal(first.restart.profile, second.restart.profile);
  assert.ok(path.isAbsolute(first.restart.profile));
  for (const key of ["hostEpoch", "workbenchInstance"]) {
    assert.ok(first.restart.scope[key] && second.restart.scope[key]);
    assert.notEqual(first.restart.scope[key], second.restart.scope[key]);
  }
  assert.equal(first.restart.initialSettings.state, "ready");
  assert.equal(first.restart.initialSettings.values.skipUnchangedAssets, true);
  const changes = first.ipc.filter((row) =>
    ["plugins:settings:update", "plugins:settings:reset"].includes(row.channel),
  );
  assert.deepEqual(
    changes.map((row) => row.channel),
    ["plugins:settings:update", "plugins:settings:reset", "plugins:settings:update"],
  );
  let previous = first.restart.initialSettings.snapshot.revision;
  const revisions = [];
  for (const [i, row] of changes.entries()) {
    const value = ok(row.result),
      expected = i === 1;
    assert.equal(
      value.snapshot.values.find((v) => v.key === "skipUnchangedAssets").value,
      expected,
    );
    assert.equal(value.receipt.revision, value.snapshot.revision);
    assert.ok(value.receipt.commitId);
    assert.ok(["file-and-directory-sync", "file-sync-only"].includes(value.receipt.durability));
    assert.equal(row.args[1].expectedRevision, previous);
    if (i) assert.ok(row.at > changes[i - 1].finishedAt);
    assert.ok(
      first.native.some(
        (event) =>
          event.type === "pointerdown" &&
          event.isTrusted === true &&
          event.at < row.at &&
          (!i || event.at > changes[i - 1].finishedAt),
      ),
      "Distinct trusted input before each CAS/reset",
    );
    if (i === 1) assert.deepEqual(row.args[1].keys, ["skipUnchangedAssets"]);
    else assert.deepEqual(row.args[1].changes, [{ key: "skipUnchangedAssets", value: false }]);
    previous = value.snapshot.revision;
    revisions.push(previous);
  }
  assert.equal(new Set(revisions).size, 3);
  const final = ok(changes[2].result);
  assert.equal(first.restart.initialSettings.snapshot.values.length, 9);
  assert.deepEqual(
    final.snapshot.values,
    first.restart.initialSettings.snapshot.values.map((row) =>
      row.key === "skipUnchangedAssets" ? { ...row, value: false } : row,
    ),
  );
  for (const p of [first, second]) {
    assert.deepEqual(p.restart.settings.snapshot, final.snapshot);
    assert.deepEqual(p.restart.formSnapshot, final.snapshot);
  }
  for (const p of [first, second]) {
    const opens = p.ipc.filter((row) => row.channel === "plugins:settings:open");
    assert.equal(opens.length, 1);
    assert.deepEqual(opens[0].result.binding.scope, p.restart.scope);
    assert.deepEqual(
      opens[0].result.snapshot,
      p === first ? first.restart.initialSettings.snapshot : final.snapshot,
    );
  }
  assert.equal(second.restart.challenge.rejected, true);
  assert.equal(second.restart.renderer.migration, "pending");
  assert.ok(
    second.ipc.some(
      (row) => row.channel === "persistence:legacy-preferences-challenge" && row.error,
    ),
  );
  assert.ok(
    !second.ipc.some((row) =>
      [
        "plugins:settings:update",
        "plugins:settings:reset",
        "persistence:legacy-preferences-submit",
      ].includes(row.channel),
    ),
  );
  assert.deepEqual(
    beforeSecond,
    afterSecond,
    "Completed import/settings changed during second process",
  );
  assert.equal(beforeSecond.originalSha256, r.originalSha256);
  assert.match(r.originalSha256, /^[a-f0-9]{64}$/);
  assert.equal(beforeSecond.settings.head.receipt.revision, final.snapshot.revision);
  assert.equal(beforeSecond.settings.head.receipt.commitId, final.receipt.commitId);
  assert.deepEqual(beforeSecond.settings.document.values, final.snapshot.values);
  assert.equal(beforeSecond.imports.length, 3);
  const plans = beforeSecond.imports.filter((item) => item.document.plan);
  assert.equal(plans.length, 1);
  const plan = plans[0].document;
  assert.equal(plan.complete, true);
  assert.equal(plan.plan.descriptorId, "kobrixa.device-preferences");
  assert.equal(plans[0].key, plan.plan.id);
  assert.equal(plan.plan.devicePreferencesEvidence.device.sha256, r.originalSha256);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].state, "committed");
  assert.ok(plan.items[0].receipt.commitId);
  assert.equal(plan.items[0].receipt.revision, first.restart.initialSettings.snapshot.revision);
  const nonce = beforeSecond.imports.find((item) => item.document.kind === "nonce")?.document;
  const barrier = beforeSecond.imports.find((item) => item.document.kind === "barrier")?.document;
  assert.equal(nonce.state, "consumed");
  assert.equal(nonce.nonce, plan.plan.preferencesEvidence.nonce);
  assert.equal(barrier.state, "complete");
  assert.ok(barrier.barrier);
  for (const p of [first, second]) {
    assert.deepEqual(p.restart.renderer.entries, nonce.raw.entries);
    assert.deepEqual(p.legacyAudit[0].entries, nonce.raw.entries);
  }
  return {
    claim: "two-process same-profile restart",
    revision: final.snapshot.revision,
    importId: plan.plan.id,
    pids: [first.mainPid, second.mainPid],
  };
}

async function runPublicProcess(directory, electron, env, phase = "") {
  const child = spawn(
    electron,
    [
      path.join(directory, "main.cjs"),
      `--device-root=${directory}`,
      ...(phase ? [`--device-restart-phase=${phase}`] : []),
    ],
    {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const known = new Set(),
    monitorErrors = [];
  const monitor = phase
    ? createProcessMonitor({
        poll: processTable,
        observe: (rows) => {
          descendants(rows, child.pid, known);
        },
        onError: (e) => monitorErrors.push(String(e)),
      })
    : null;
  monitor?.tick();
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      logs.push(bytes.toString());
      process.stderr.write(bytes);
    });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }, 150_000);
  const outside = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  })
    .catch((error) => ({ code: null, signal: null, error: String(error) }))
    .finally(() => clearTimeout(timer));
  await monitor?.stop();
  const survivors = phase
    ? await finishProcessObservation({
        poll: processTable,
        parent: child.pid,
        known,
        onError: (e) => monitorErrors.push(String(e)),
      })
    : [];
  const processResult = { ...outside, pid: child.pid, timedOut, survivors, monitorErrors };
  await writeFile(
    path.join(directory, phase ? `process-restart-${phase}.json` : "process.json"),
    JSON.stringify(processResult, null, 2),
  );
  await writeFile(
    path.join(directory, phase ? `native-restart-${phase}.log` : "native.log"),
    logs.join(""),
  );
  assert.deepEqual(monitorErrors, []);
  assert.deepEqual(survivors, []);
  assert.equal(timedOut, false, "Native timeout");
  assert.equal(outside.code, 0, "Native producer failed; inspect producer.json/native.log");
  assert.equal(outside.signal, null);
  return { ...outside, pid: child.pid, timedOut, survivors };
}

async function main(args) {
  const restartMode = args.includes("--restart");
  assert.ok(
    ["--build-only", "--run", "--run-built"].includes(args[0]),
    "Use --build-only | --run | --run-built <absolute directory> [--restart]",
  );
  const directory =
    args[0] === "--run-built"
      ? await realpath(args[1])
      : await realpath(await mkdtemp("/private/tmp/kobrixa-device-public-"));
  console.log(`Device public artifacts: ${directory}`);
  const identity =
    args[0] === "--run-built"
      ? JSON.parse(await readFile(path.join(directory, "artifact-identity.json"), "utf8"))
      : await buildDevice(directory);
  if (args[0] === "--build-only") {
    console.log("BUILD ONLY: Electron was not launched; no native PASS claimed.");
    return;
  }
  assert.equal(
    digest(await readFile(fileURLToPath(import.meta.url))),
    identity.sourceHashes["tests/desktop/device-ui-public-run.mjs"],
    "Oracle changed since build; rebuild before native execution",
  );
  for (const [file, hash] of Object.entries(identity.artifactHashes))
    assert.equal(
      digest(await readFile(path.join(directory, file))),
      hash,
      `Changed artifact ${file}`,
    );
  // An existing profile/receipt must never silently turn this into a replay run.
  assert.deepEqual(
    await readdir(path.join(directory, "profile")),
    [],
    "Native run requires a fresh isolated profile",
  );
  await writeFile(
    path.join(directory, "profile/device-settings.json"),
    JSON.stringify(legacyDevice),
  );
  const require = createRequire(path.join(dependencies, "apps/desktop/package.json"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = require("electron");
  if (restartMode) {
    const originalSha256 = digest(
      await readFile(path.join(directory, "profile/device-settings.json")),
    );
    const outside = [];
    outside.push(await runPublicProcess(directory, electron, env, "1"));
    const first = JSON.parse(await readFile(path.join(directory, "producer-restart-1.json")));
    const beforeSecond = await snapshotRestartProfile(path.join(directory, "profile"));
    outside.push(await runPublicProcess(directory, electron, env, "2"));
    const second = JSON.parse(await readFile(path.join(directory, "producer-restart-2.json")));
    const afterSecond = await snapshotRestartProfile(path.join(directory, "profile"));
    const evidence = { first, second, outside, originalSha256, beforeSecond, afterSecond };
    await writeFile(
      path.join(directory, "restart-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    const verified = verifyRestartReceipt(evidence);
    await writeFile(
      path.join(directory, "restart-receipt.json"),
      JSON.stringify(
        {
          verified,
          identity,
          evidenceSha256: digest(await readFile(path.join(directory, "restart-evidence.json"))),
        },
        null,
        2,
      ),
    );
    console.log(`Actual same-profile restart PASS: ${directory}`);
    return;
  }
  const outside = await runPublicProcess(directory, electron, env);
  const producerBytes = await readFile(path.join(directory, "producer.json"));
  const verified = verifyDeviceReceipt(JSON.parse(producerBytes));
  const receipt = { verified, outside, producerSha256: digest(producerBytes), identity };
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`Actual public device PASS: ${path.join(directory, "receipt.json")}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
