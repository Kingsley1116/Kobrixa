import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
  rm,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { isBuiltin, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir, networkInterfaces } from "node:os";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { verifyLeaf, digest, copyInstalledLeaf } from "./sensor-lab-installed-artifacts.mjs";
import { verifyLabReceipt } from "./sensor-lab-public-run.mjs";
import { processTable, descendants } from "./builtin-installed-client.mjs";
import { createProcessMonitor, finishProcessObservation } from "./device-ui-stdio-run.mjs";
const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const pluginId = "kobrixa.sensor-lab";
export async function auditPayload(artifact, dependencies = process.env.KOBRIXA_E6_DEPS ?? root) {
  const require = createRequire(path.join(dependencies, "package.json"));
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  // Audit, do not rewrite, the artifact's SDK dependency closure.
  return build({
    entryPoints: [path.join(artifact, "main.cjs")],
    bundle: true,
    platform: "node",
    write: false,
    logLevel: "silent",
    metafile: true,
    plugins: [
      {
        name: "no-product-external-dependencies",
        setup(context) {
          context.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return;
            assert.ok(isBuiltin(args.path), `Unbundled product dependency: ${args.path}`);
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
}
export async function buildInstalled(directory, artifact) {
  assert.ok(path.isAbsolute(artifact));
  const index = await verifyLeaf(artifact);
  // The current product supplies EV3 provider policy through its optional source.
  // Preserve that real packaged dependency; never force a disabled provider on.
  const providerArtifact = path.join(path.dirname(artifact), "device-ev3");
  const providerIndex = await verifyLeaf(providerArtifact, "kobrixa.device-ev3");
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const payloadAudit = await auditPayload(artifact);
  await writeFile(
    path.join(directory, "payload-audit.json"),
    JSON.stringify(payloadAudit.metafile, null, 2),
  );
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const vite = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
  await mkdir(path.join(directory, "profile"), { recursive: true });
  await mkdir(path.join(directory, "plugins/sensor-lab/ui"), { recursive: true });
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, [file]]) => [
      name,
      path.join(root, file),
    ]),
  );
  const common = {
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
      "tests/desktop/sensor-lab-installed-run.mjs",
      "tests/desktop/sensor-lab-public-run.mjs",
      "tests/desktop/sensor-lab-installed-artifacts.mjs",
      "tests/desktop/sensor-lab-installed-test.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
      "tests/desktop/builtin-installed-landlock.py",
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
      inputs.add(absolute);
    }
    await writeFile(
      path.join(directory, name.replaceAll("/", "-") + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
  };
  await bundle(
    "main.cjs",
    `import {app} from "electron"; import {runInstalledLab} from ${JSON.stringify(path.join(root, "tests/desktop/sensor-lab-installed-main.ts"))}; try { runInstalledLab(); } catch(error) { console.error(error); app.exit(1); }`,
  );
  await bundle(
    "persistence-worker.cjs",
    `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))}; runShippedPersistenceWorker();`,
  );
  await bundle(
    "preload.cjs",
    `import ${JSON.stringify(path.join(root, "apps/desktop/src/preload/index.ts"))};`,
  );
  // ONLY copy the supplied product build leaf. Never bundle feature source here.
  const leaf = path.join(directory, "plugins/sensor-lab");
  const files = index.files;
  await copyInstalledLeaf(artifact, leaf, pluginId);
  await copyInstalledLeaf(
    providerArtifact,
    path.join(directory, "plugins/device-ev3"),
    "kobrixa.device-ev3",
  );
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
    base: "./",
    resolve: { alias, dedupe: ["react", "react-dom"] },
    plugins: [
      {
        name: "actual-lab-generic-shell",
        generateBundle() {
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
            html.replace(
              'src="/src/renderer/index.tsx"',
              `src="/@fs/${path.join(root, "tests/desktop/sensor-lab-installed-renderer.ts")}"`,
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
    "payload-audit.json",
    "persistence-worker.cjs",
    "preload.cjs",
    ...files.map((f) => `plugins/sensor-lab/${f.path}`),
    "plugins/sensor-lab/resource-index.json",
    ...providerIndex.files.map((f) => `plugins/device-ev3/${f.path}`),
    "plugins/device-ev3/resource-index.json",
    ...(await readdir(path.join(directory, "renderer"), { recursive: true }))
      .filter((f) => /\.(html|js|css)$/.test(f))
      .map((f) => `renderer/${f}`),
  ])
    artifactHashes[name] = digest(await readFile(path.join(directory, name)));
  for (const file of [...inputs].sort())
    sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  const identity = {
    root,
    claim: "installed-payload acceptance host, not unmodified packaged product",
    productDependencies: [
      {
        pluginId: "kobrixa.device-ev3",
        path: providerArtifact,
        leaf: "plugins/device-ev3",
        index: providerIndex,
        indexSha256: digest(await readFile(path.join(providerArtifact, "resource-index.json"))),
      },
    ],
    productArtifact: {
      path: artifact,
      index,
      indexSha256: digest(await readFile(path.join(leaf, "resource-index.json"))),
      buildCommit: "unattested: supply packaging receipt separately",
    },
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    artifactHashes,
    sourceHashes,
  };
  return finishInstalledBuild(directory, artifact, identity);
}
export async function finishInstalledBuild(directory, artifact, identity, dependencies = root) {
  const desktopRequire = createRequire(path.join(dependencies, "apps/desktop/package.json"));
  for (const name of [
    "sensor-lab-installed-run.mjs",
    "sensor-lab-installed-artifacts.mjs",
    "builtin-installed-client.mjs",
    "builtin-installed-landlock.py",
    "device-ui-stdio-run.mjs",
  ]) {
    const file = path.join(root, "tests/desktop", name);
    identity.sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  }
  const electron = desktopRequire("electron");
  assert.ok(["darwin", "linux"].includes(process.platform));
  const runtimeDirectory = process.platform === "darwin" ? "Electron.app" : "electron-runtime";
  const appRoot =
    process.platform === "darwin" ? path.resolve(electron, "../../..") : path.dirname(electron);
  if (process.platform === "darwin") assert.ok(appRoot.endsWith(".app"));
  await cp(appRoot, path.join(directory, runtimeDirectory), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  // Framework links must remain within the copied runtime, never resolve into checkout.
  await assertInternalLinks(path.join(directory, runtimeDirectory));
  identity.runtime = {
    directory: runtimeDirectory,
    executable:
      process.platform === "darwin"
        ? "Electron.app/Contents/MacOS/Electron"
        : "electron-runtime/electron",
    platform: process.platform,
    arch: process.arch,
    files: await treeHashes(path.join(directory, runtimeDirectory)),
  };
  identity.deniedRoots = [
    ...new Set([
      await realpath(root),
      await realpath(artifact),
      await realpath(
        path.resolve(
          root,
          execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          "..",
        ),
      ),
      path.dirname(await realpath(path.join(dependencies, "node_modules"))),
      await realpath(dependencies),
    ]),
  ];
  identity.probes = await Promise.all(
    identity.deniedRoots.map(async (directory) => {
      for (const name of ["package.json", "main.cjs", "node_modules/.modules.yaml"]) {
        const file = path.join(directory, name);
        try {
          await readFile(file);
          return file;
        } catch {
          /* Try the next known-readable probe / already-exited cleanup target. */
        }
      }
      throw Error(`No readable isolation probe in ${directory}`);
    }),
  );
  await mkdir(path.join(directory, "empty-path"));
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return identity;
}

async function assertInternalLinks(directory, base = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      assert.ok(
        (await realpath(file)).startsWith(base + path.sep),
        `External runtime link ${file}`,
      );
    else if (entry.isDirectory()) await assertInternalLinks(file, base);
  }
}
async function treeHashes(directory, base = directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await treeHashes(file, base));
    else if (entry.isFile()) result[path.relative(base, file)] = digest(await readFile(file));
  }
  return result;
}

export function verifyInstalledReceipt(report) {
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.equal(report.hostKind, "installed-payload-acceptance-host");
  assert.ok(
    report.checkpoints.isolation.sourceDenied &&
      report.checkpoints.isolation.networkDenied &&
      report.checkpoints.isolation.noPathNode,
  );
  for (const c of [report.cleanup.bridge, report.cleanup.worker])
    for (const v of Object.values(c)) assert.equal(v, 0);
  assert.equal(report.cleanup.workers, 0);
  if (report.scenario !== "healthy") {
    assert.ok(["absent", "missing-resource", "tampered"].includes(report.scenario));
    assert.deepEqual(report.launches, []);
    assert.deepEqual(report.exits, []);
    assert.deepEqual(report.wire, []);
    assert.deepEqual(report.drains, []);
    assert.equal(report.checkpoints.negative.row.status, "invalid");
    assert.ok(report.checkpoints.negative.row.problems.some((p) => p.code === "PLUGIN_E_ENTRY"));
    assert.equal(report.checkpoints.negative.catalog.ok, true);
    assert.ok(
      !report.checkpoints.negative.catalog.value.entries.some((e) => e.pluginId === pluginId),
    );
    return { scenario: report.scenario };
  }
  assert.equal(report.checkpoints.chromiumSandbox, true);
  assert.equal(report.launches.length, 2);
  assert.equal(report.exits.length, 2);
  const first = report.launches[0].owner,
    second = report.launches[1].owner;
  assert.notDeepEqual(first, second);
  assert.deepEqual(report.exits[0].owner, first);
  assert.deepEqual(report.exits[1].owner, second);
  assert.ok(
    report.exits[0].at < report.launches[1].at &&
      report.exits[1].at > report.checkpoints.management.at,
  );
  const originalWire = report.wire.filter((r) => JSON.stringify(r.owner) === JSON.stringify(first));
  // D7 oracle retains all actual original-generation evidence; the new generation
  // is checked separately, never represented as the original process.
  const data = verifyLabReceipt({
    ...report,
    launches: [report.launches[0]],
    exits: [report.exits[0]],
    wire: originalWire,
  });
  const pair = (method) => {
    const requests = originalWire.filter(
      (r) => r.direction === "plugin-host" && r.message.method === method,
    );
    assert.equal(requests.length, 1, method);
    const request = requests[0];
    const responses = originalWire.filter(
      (r) =>
        r.direction === "host-plugin" &&
        r.sequence > request.sequence &&
        r.message.id === request.message.id &&
        !r.message.method,
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].message.result?.ok, true);
    return {
      request,
      response: responses[0],
      params: request.message.params,
      value: responses[0].message.result.value,
    };
  };
  const copied = pair("ui/copyText");
  assert.equal(copied.value.copied, true);
  assert.ok(copied.params.text.length > 0);
  assert.equal(report.checkpoints.copy.text, copied.params.text);
  assert.equal(report.checkpoints.copy.displayed, copied.params.text);
  const begin = pair("storage/exportBegin"),
    commit = pair("storage/exportCommit");
  assert.equal(commit.params.export, begin.value.export);
  assert.equal(commit.value.exported, true);
  const bytes = Buffer.from(report.checkpoints.export.bytes, "base64");
  assert.equal(bytes.length, begin.params.byteLength);
  assert.equal(digest(bytes), begin.params.sha256);
  for (const [action, node, exchange] of [
    ["copy-code", "code", copied],
    ["export", "export", begin],
  ]) {
    const commands = originalWire.filter(
      (r) =>
        r.direction === "host-plugin" &&
        r.message.method === "command/invoke" &&
        r.message.params.command === `${pluginId}.${action}`,
    );
    assert.equal(commands.length, 1);
    const invocation = commands[0];
    assert.equal(invocation.message.params.context.origin, "panel");
    assert.equal(invocation.message.params.context.binding.kind, "panel");
    assert.equal(invocation.message.params.context.actionRef, exchange.params.actionRef);
    assert.ok(
      typeof exchange.params.actionRef === "string" && exchange.params.actionRef.length > 0,
    );
    assert.ok(invocation.at <= exchange.request.at);
    assert.ok(
      report.native.some(
        (e) =>
          e.type === "pointerdown" &&
          e.isTrusted &&
          e.node === node &&
          e.at <= invocation.at &&
          invocation.at - e.at < 2000,
      ),
    );
  }
  const chunks = originalWire.filter(
    (r) => r.direction === "plugin-host" && r.message.method === "storage/exportChunk",
  );
  const written = [];
  let offset = 0;
  for (const chunk of chunks) {
    const p = chunk.message.params;
    assert.equal(p.export, begin.value.export);
    assert.equal(p.offset, offset);
    assert.ok(chunk.sequence > begin.response.sequence && chunk.sequence < commit.request.sequence);
    const data = Buffer.from(p.data, "base64");
    assert.ok(data.length > 0);
    written.push(data);
    offset += data.length;
    const replies = originalWire.filter(
      (r) =>
        r.direction === "host-plugin" &&
        !r.message.method &&
        r.message.id === chunk.message.id &&
        r.sequence > chunk.sequence,
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0].message.result?.ok, true);
    assert.equal(replies[0].message.result.value.receivedBytes, offset);
  }
  assert.deepEqual(Buffer.concat(written), bytes, "Original job bytes equal native output");
  for (const enabled of [false, true]) {
    const calls = report.ipc.filter(
      (r) =>
        r.channel === "plugins:set-enabled" &&
        r.args[0] === `builtin:${pluginId}` &&
        r.args[1] === enabled,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].result.ok, true);
  }

  for (const method of ["devices/recording/reserve", "storage/exportBegin", "ui/copyText"]) {
    assert.equal(
      report.wire.filter((r) => r.message.method === method && r.direction === "plugin-host")
        .length,
      1,
      `No re-enable replay ${method}`,
    );
  }
  for (const result of [
    report.checkpoints.management.disabled,
    report.checkpoints.management.enabled,
  ]) {
    assert.equal(result.ok, true);
    assert.notEqual(result.persisted, false);
  }
  return { ...data, exportSha256: digest(bytes), copiedText: copied.params.text, newOwner: second };
}

export const labInstalledOptions = Object.freeze({
  pluginId,
  slug: "sensor-lab",
  switchPrefix: "lab",
  missingResource: "ui/panel.json",
  verify: verifyInstalledReceipt,
});
export async function prepareScenarioProfile(
  directory,
  runRoot,
  identity,
  options = labInstalledOptions,
) {
  const profile = path.join(runRoot, "profile");
  await mkdir(profile); // Never overwrite or copy a previously consumed profile.
  if (options.slug !== "device-ev3") {
    assert.equal(options.profileFixture, undefined);
    return;
  }
  const allowed = { path: "fixtures/device-settings.json", target: "device-settings.json" };
  assert.deepEqual(options.profileFixture, allowed);
  assert.ok(identity.profileFixture, "Device scenario requires immutable original fixture");
  assert.deepEqual(
    { path: identity.profileFixture.path, target: identity.profileFixture.target },
    allowed,
  );
  const expected = identity.artifactHashes[allowed.path];
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(identity.profileFixture.sha256, expected);
  const source = path.join(directory, allowed.path),
    stat = await lstat(source);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
  const bytes = await readFile(source);
  assert.equal(digest(bytes), expected);
  await writeFile(path.join(profile, allowed.target), bytes, { flag: "wx" });
  assert.equal(digest(await readFile(path.join(profile, allowed.target))), expected);
}
export async function runInstalled(directory, options = labInstalledOptions) {
  const { pluginId, slug, switchPrefix, missingResource, verify } = options;
  assert.ok(["sensor-lab", "device-ev3"].includes(slug));
  assert.equal(pluginId, "kobrixa." + slug);
  const leafPath = `plugins/${slug}`;
  assert.ok(["darwin", "linux"].includes(process.platform), "No unisolated fallback");
  const externalAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal);
  if (process.platform === "linux") {
    assert.ok(["arm64", "x64"].includes(process.arch), "Landlock architecture");
    assert.equal(
      externalAddresses.length,
      0,
      "Linux requires a networkless namespace as well as Landlock",
    );
  }
  const identity = JSON.parse(
    await readFile(path.join(directory, "artifact-identity.json"), "utf8"),
  );
  for (const [file, hash] of Object.entries(identity.sourceHashes)) {
    // Oracle/build identity checked by the controller before source denial begins.
    assert.equal(
      digest(await readFile(path.resolve(root, file))),
      hash,
      `Source changed since prepare: ${file}`,
    );
  }
  for (const [file, hash] of Object.entries(identity.artifactHashes))
    assert.equal(digest(await readFile(path.join(directory, file))), hash, file);
  assert.equal(identity.runtime.platform, process.platform);
  assert.equal(identity.runtime.arch, process.arch);
  await assertInternalLinks(path.join(directory, identity.runtime.directory));
  assert.deepEqual(
    await treeHashes(path.join(directory, identity.runtime.directory)),
    identity.runtime.files,
  );
  assert.deepEqual(
    await verifyLeaf(path.join(directory, leafPath), pluginId),
    identity.productArtifact.index,
  );
  assert.equal(
    digest(await readFile(path.join(directory, leafPath, "resource-index.json"))),
    identity.productArtifact.indexSha256,
  );
  if (slug === "sensor-lab") {
    assert.equal(identity.productDependencies?.length, 1, "Lab requires original provider payload");
    const dependency = identity.productDependencies[0];
    assert.equal(dependency.pluginId, "kobrixa.device-ev3");
    assert.equal(dependency.leaf, "plugins/device-ev3");
    assert.deepEqual(
      await verifyLeaf(path.join(directory, dependency.leaf), dependency.pluginId),
      dependency.index,
    );
    assert.equal(
      digest(await readFile(path.join(directory, dependency.leaf, "resource-index.json"))),
      dependency.indexSha256,
    );
  }
  const receipts = [];
  for (const scenario of ["healthy", "absent", "missing-resource", "tampered"]) {
    const runRoot = path.join(directory, scenario);
    await mkdir(runRoot); // No profile replay or overwritten evidence.
    for (const name of ["main.cjs", "preload.cjs", "persistence-worker.cjs", "renderer", "plugins"])
      await cp(path.join(directory, name), path.join(runRoot, name), { recursive: true });
    await prepareScenarioProfile(directory, runRoot, identity, options);
    const privateTmp = path.join(runRoot, "t");
    await mkdir(privateTmp);
    if (scenario === "absent") await rm(path.join(runRoot, leafPath, "main.cjs"));
    if (scenario === "missing-resource") await rm(path.join(runRoot, leafPath, missingResource));
    if (scenario === "tampered")
      await writeFile(path.join(runRoot, leafPath, "ui/panel.json"), "{}\n");
    const isolation = path.join(runRoot, "isolation.sb");
    // Chromium's macOS singleton uses confstr(_CS_DARWIN_USER_TEMP_DIR),
    // independently of TMPDIR. Permit only its local instance-lock socket.
    const singletonRoot = (await realpath(tmpdir()))
      .replace(/\/$/, "")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const singletonRule = `(allow network-bind (regex ${JSON.stringify(`^${singletonRoot}/scoped_dir[A-Za-z0-9]+/SingletonSocket$`)}))`;
    await writeFile(
      isolation,
      `(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))\n(allow network-bind (subpath ${JSON.stringify(privateTmp)}))\n${singletonRule}\n${identity.deniedRoots.map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`).join("\n")}\n`,
    );
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const env = {
      ...process.env,
      PATH: path.join(directory, "empty-path"),
      TMPDIR: privateTmp + path.sep,
      LAB_SOURCE_PROBES: JSON.stringify(identity.probes),
      LAB_NETWORK_PROBE: String(server.address().port),
    };
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH"])
      delete env[key];
    const child = spawn(
      process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/python3",
      [
        ...(process.platform === "darwin"
          ? ["-f", isolation, path.join(directory, identity.runtime.executable)]
          : [
              path.join(root, "tests/desktop/builtin-installed-landlock.py"),
              ...identity.deniedRoots,
              "--",
              path.join(directory, identity.runtime.executable),
            ]),
        path.join(runRoot, "main.cjs"),
        `--${switchPrefix}-root=${runRoot}`,
        `--${switchPrefix}-scenario=${scenario}`,
        ...(slug === "device-ev3" ? ["--device-installed"] : []),
      ],
      { cwd: runRoot, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const known = new Set();
    let stdout = "",
      stderr = "",
      timeout = false,
      outputOverflow = false;
    child.stdout.on("data", (b) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + b.length > 8 * 1024 * 1024) {
        outputOverflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + b.length > 8 * 1024 * 1024) {
        outputOverflow = true;
        child.kill("SIGKILL");
        return;
      }
      stderr += b;
    });
    const monitorErrors = [];
    const monitor = createProcessMonitor({
      poll: processTable,
      observe: (rows) => {
        descendants(rows, child.pid, known);
      },
      onError: (error) => monitorErrors.push(String(error)),
    });
    monitor.tick();
    const timer = setTimeout(() => {
      timeout = true;
      child.kill("SIGKILL");
    }, 150_000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    } catch (error) {
      result = { error: String(error) };
    } finally {
      clearTimeout(timer);
      await monitor.stop();
      await new Promise((resolve) => server.close(resolve));
      await writeFile(path.join(runRoot, "native.log"), stdout + "\n" + stderr);
    }
    const survivors = await finishProcessObservation({
      poll: processTable,
      parent: child.pid,
      known,
      onError: (error) => monitorErrors.push(String(error)),
    });
    await writeFile(
      path.join(runRoot, "process.json"),
      JSON.stringify(
        { result, timeout, known: [...known], survivors, monitorErrors, outputOverflow },
        null,
        2,
      ),
    );
    assert.deepEqual(monitorErrors, []);
    assert.equal(timeout, false);
    assert.equal(outputOverflow, false);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.deepEqual(survivors, []);
    const report = JSON.parse(await readFile(path.join(runRoot, "producer.json"), "utf8"));
    assert.equal(report.scenario, scenario);
    if (options.profileFixture)
      assert.equal(
        digest(await readFile(path.join(runRoot, "profile", options.profileFixture.target))),
        identity.profileFixture.sha256,
        "Original fixture bytes changed",
      );
    assert.deepEqual(report.checkpoints.isolation.probes, identity.probes);
    for (const launch of report.launches) {
      assert.equal(launch.entry, path.join(runRoot, leafPath, "main.cjs"));
      assert.equal(
        launch.sha256,
        identity.productArtifact.index.files.find((f) => f.path === "main.cjs").sha256,
      );
    }
    receipts.push({
      scenario,
      ...(options.profileFixture ? { profileFixtureSha256: identity.profileFixture.sha256 } : {}),
      verified: verify(report),
      producerSha256: digest(await readFile(path.join(runRoot, "producer.json"))),
    });
  }
  await writeFile(
    path.join(directory, "installed.json"),
    JSON.stringify(
      {
        claim: identity.claim,
        platform: process.platform,
        arch: process.arch,
        externalAddresses,
        receipts,
        identity,
      },
      null,
      2,
    ),
  );
}
async function main(args) {
  if (args[0] === "--prepare") {
    assert.ok(
      args[1] && path.isAbsolute(args[1]),
      "--prepare <absolute product .vite/build/plugins/sensor-lab leaf>",
    );
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-lab-installed-")));
    await buildInstalled(directory, args[1]);
    console.log(
      `Prepared ${directory}; Electron NOT RUN. Controller: node tests/desktop/sensor-lab-installed-run.mjs --run-built ${directory}`,
    );
  } else {
    assert.equal(args[0], "--run-built");
    await runInstalled(await realpath(args[1]));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
