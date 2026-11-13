import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { processTable, descendants } from "./builtin-installed-client.mjs";
const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const hash = (b) => createHash("sha256").update(b).digest("hex");
export const ownerId = "acceptance.lab-stdio";
export function documents(role) {
  assert.ok(["owner", "foreign", "denied"].includes(role));
  const id = ownerId + (role === "owner" ? "" : "-" + role);
  const commands = [{ id: id + ".run", title: { en: "Run synthetic parity" } }];
  if (role === "owner")
    commands.push(
      ...["finish", "verify"].map((name) => ({ id: id + "." + name, title: { en: name } })),
      { id: id + ".copy", title: { en: "Copy" }, invocation: "context-v1", arguments: {} },
    );
  const panels =
    role === "owner"
      ? [
          {
            id: id + ".panel",
            title: { en: "Synthetic Python parity" },
            location: "right",
            resource: { version: 2, path: "panel.json" },
          },
        ]
      : [];
  const status = {
    kind: "status",
    tone: "neutral",
    text: { text: { en: "Synthetic Python parity" } },
    data: {},
    actions: [],
  };
  const manifest = {
    id,
    version: "1.0.0",
    apiVersion: "^1.8.0",
    displayName: { en: "Synthetic Python " + role },
    runtime: { kind: "python", entry: "consumer.py" },
    permissions:
      role === "denied"
        ? ["storage.read", "ui.status"]
        : [
            "ui.panels",
            "ui.status",
            "devices.read",
            "storage.read",
            "storage.write",
            "storage.export",
            "ui.clipboard",
          ],
    ...(role === "denied"
      ? {}
      : { requires: { devices: [{ capability: "telemetry.v1", required: true }] } }),
    activationEvents: [
      ...commands.map((c) => "onCommand:" + c.id),
      ...panels.map((p) => "onPanel:" + p.id),
    ],
    contributes: {
      commands,
      ...(panels.length
        ? { panels }
        : {
            status: [
              {
                id: id + ".status",
                title: { en: "Parity" },
                resource: { version: 2, path: "status.json" },
              },
            ],
          }),
    },
  };
  const panel = {
    kind: "panel",
    formSync: true,
    root: "root",
    presentationKey: "presentation",
    datasets: { code: { kind: "code" } },
    fields: {
      draft: {
        schema: { type: "string", maxLength: 128, nullable: false },
        initial: "",
        required: false,
      },
    },
    data: {
      presentation: {
        schema: {
          type: "number",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          integer: true,
          nullable: false,
        },
        initial: 0,
      },
    },
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["draft", "code", "copy"] },
      { id: "draft", type: "textInput", field: "draft", label: { en: "Draft" } },
      {
        id: "code",
        type: "code",
        label: { en: "Code" },
        dataset: "code",
        copy: { command: id + ".copy", arguments: {} },
      },
      {
        id: "copy",
        type: "action",
        variant: "normal",
        label: { en: "Copy" },
        action: { kind: "command", command: id + ".copy", arguments: {} },
      },
    ],
  };
  return { manifest, panel, status };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function pairs(report, pluginId, method, direction = "plugin-host") {
  return report.wire
    .filter(
      (r) =>
        r.owner.pluginId === pluginId && r.direction === direction && r.message.method === method,
    )
    .map((request) => {
      const replies = report.wire.filter(
        (r) =>
          same(r.owner, request.owner) &&
          r.direction !== direction &&
          r.sequence > request.sequence &&
          r.message.id === request.message.id &&
          !r.message.method,
      );
      assert.equal(replies.length, 1, `correlated response ${pluginId} ${method}`);
      return {
        request,
        response: replies[0],
        params: request.message.params,
        result: replies[0].message.result,
      };
    });
}
const ok = (p) => {
  assert.equal(p.result?.ok, true, JSON.stringify(p.result));
  return p.result.value;
};
const bad = (p, code) => {
  assert.equal(p.result?.ok, false);
  if (code) assert.equal(p.result.error.code, code);
};
export function verifyStdio(report) {
  assert.equal(report.claim, "synthetic-python-stdio-parity");
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.equal(report.launches.length, 3);
  assert.equal(report.exits.length, 3);
  for (const role of ["owner", "foreign", "denied"]) {
    const launches = report.launches.filter((l) => l.role === role);
    assert.equal(launches.length, 1);
    const owner = launches[0].owner;
    const exits = report.exits.filter((e) => same(e.owner, owner));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].exit.code, 0);
    const hello = pairs(report, owner.pluginId, "initialize", "host-plugin");
    assert.equal(hello.length, 1);
    assert.equal(hello[0].response.message.result.apiVersion, "1.8.0");
    const negotiation = pairs(report, owner.pluginId, "ui/negotiate", "host-plugin");
    assert.equal(negotiation.length, 1);
    assert.ok(ok(negotiation[0]).uiResourceVersions.includes(2));
    assert.deepEqual(
      ok(negotiation[0]).uiResourceVersions,
      negotiation[0].params.uiResourceVersions.filter((v) => v === 1 || v === 2),
    );
  }
  const p = (m) => pairs(report, ownerId, m),
    good = (m) => p(m).filter((r) => r.result?.ok);
  const form = p("ui/formPatch");
  assert.equal(form.length, 2);
  const patched = ok(form[0]);
  bad(form[1], "PLUGIN_E_STALE_RESOURCE");
  assert.deepEqual(form[0].params.binding, report.checkpoints.binding);
  assert.equal(patched.formRevision, form[0].params.baseFormRevision + 1);
  const begins = good("ui/dataBegin");
  assert.equal(begins.length, 2);
  const begin = begins[0],
    transfer = ok(begin).transfer;
  const chunks = p("ui/dataChunk");
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0].params, chunks[1].params);
  assert.equal(chunks[0].params.transfer, transfer);
  assert.equal(ok(chunks[0]).nextOffset, 2);
  assert.equal(ok(chunks[1]).nextOffset, 2);
  const canonical = Buffer.from(
    JSON.stringify([begin.params.header, chunks[0].params.chunk.entries]),
  );
  assert.equal(hash(canonical), begin.params.sha256);
  assert.equal(canonical.length, begin.params.byteLength);
  const commits = p("ui/dataCommit");
  assert.equal(commits.length, 2);
  const committed = ok(commits[0]);
  assert.equal(commits[0].params.transfer, transfer);
  assert.equal(committed.sha256, begin.params.sha256);
  bad(commits[1], "PLUGIN_E_STALE_RESOURCE");
  const aborted = p("ui/dataAbort");
  assert.equal(aborted.length, 1);
  assert.equal(ok(aborted[0]).aborted, true);
  assert.equal(aborted[0].params.transfer, ok(begins[1]).transfer);
  assert.equal(commits[1].params.transfer, aborted[0].params.transfer);
  const pages = good("ui/dataRead");
  assert.equal(pages.length, 3);
  const entries = [];
  for (const [i, page] of pages.entries()) {
    assert.equal(page.params.revision, committed.revision);
    assert.equal(page.params.offset, i);
    const v = ok(page);
    assert.equal(v.nextOffset, Math.min(i + 1, 2));
    assert.equal(v.done, i >= 1);
    entries.push(...v.chunk.entries);
  }
  assert.deepEqual(entries, chunks[0].params.chunk.entries);
  bad(p("ui/dataRead").at(-1), "PLUGIN_E_STALE_RESOURCE");
  assert.equal(ok(good("ui/dataSnapshot")[0]).datasets[0].sha256, begin.params.sha256);
  const subscribed = good("ui/subscribe")[0];
  assert.deepEqual(subscribed.params.topics, ["data"]);
  const subscription = ok(subscribed).subscriptionId;
  assert.ok(
    report.wire.some(
      (r) =>
        r.direction === "host-plugin" &&
        r.owner.pluginId === ownerId &&
        r.message.method === "events/deliver" &&
        r.message.params.subscriptionId === subscription &&
        r.message.params.kind === "ui.data",
    ),
  );
  assert.ok(good("events/ack").some((r) => r.params.subscriptionId === subscription));
  assert.equal(good("ui/snapshot")[0].params.subscriptionId, subscription);
  assert.equal(good("events/unsubscribe")[0].params.subscriptionId, subscription);
  for (const [id, method, code] of [
    [ownerId + "-foreign", "ui/dataSnapshot", "PLUGIN_E_STALE_RESOURCE"],
    [ownerId + "-foreign", "storage/readChunk", null],
    [ownerId + "-foreign", "devices/recording/query", null],
    [ownerId + "-denied", "ui/dataSnapshot", "PLUGIN_E_STALE_RESOURCE"],
    [ownerId + "-denied", "storage/beginWrite", "PLUGIN_E_PERMISSION_DENIED"],
  ]) {
    const rows = pairs(report, id, method);
    assert.equal(rows.length, 1);
    bad(rows[0], code);
  }
  const reserve = good("devices/recording/reserve");
  assert.equal(reserve.length, 1);
  const reservation = ok(reserve[0]).reservation.reservationId;
  const registered = good("storage/registerCheckpoint");
  assert.equal(registered.length, 1);
  const checkpoint = ok(registered[0]).checkpoint;
  assert.equal(registered[0].params.reservation, reservation);
  assert.deepEqual(
    pairs(report, ownerId + "-foreign", "ui/dataSnapshot")[0].params.binding,
    report.checkpoints.binding,
  );
  assert.equal(
    pairs(report, ownerId + "-foreign", "devices/recording/query")[0].params.reservationId,
    reservation,
  );
  const initial = good("storage/beginWrite").find((r) => r.params.target.mode === "create");
  assert.ok(initial);
  const initialMeta = ok(
    good("storage/commitWrite").find((r) => r.params.write === ok(initial).write),
  ).record;
  assert.equal(initialMeta.id, registered[0].params.id);
  assert.equal(initialMeta.revision, registered[0].params.expectedRevision);
  const initialPin = good("storage/openRead").find(
    (r) => r.params.expectedRevision === initialMeta.revision,
  );
  assert.ok(initialPin);
  assert.equal(initialPin.params.id, initialMeta.id);
  assert.equal(
    pairs(report, ownerId + "-foreign", "storage/readChunk")[0].params.read,
    ok(initialPin).read,
  );

  const releases = good("devices/recording/release");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].params.reservationId, reservation);
  const drain = report.drains.find((d) =>
    d.offer.checkpoints.some((c) => c.checkpoint === checkpoint),
  );
  assert.ok(drain);
  assert.equal(drain.report.state, "saved");
  assert.equal(drain.report.blocker, false);
  assert.deepEqual(drain.report.errors, []);
  const submitted = pairs(report, ownerId, "storage/drain", "host-plugin").find(
    (r) => r.params.token === drain.offer.token,
  );
  assert.ok(submitted);
  assert.equal(ok(submitted).status, "submitted");
  const finals = p("storage/beginWrite").filter((r) => r.params.checkpoint?.phase === "final");
  assert.equal(finals.length, 2);
  bad(finals[0]);
  assert.notEqual(finals[0].params.drainToken, drain.offer.token);
  const final = finals[1],
    write = ok(final).write;
  assert.equal(final.params.drainToken, drain.offer.token);
  assert.equal(final.params.checkpoint.handle, checkpoint);
  assert.equal(final.params.target.id, registered[0].params.id);
  assert.equal(final.params.target.expectedRevision, initialMeta.revision);
  assert.deepEqual(drain.offer.owner, initial.request.owner);
  assert.deepEqual(ok(submitted).writes, [write]);
  const committedFinal = good("storage/commitWrite").find((r) => r.params.write === write);
  assert.ok(committedFinal);
  assert.equal(committedFinal.params.drainToken, drain.offer.token);
  const meta = ok(committedFinal).record;
  assert.equal(meta.checkpoint, "final");
  assert.ok(
    drain.report.records.some(
      (r) => r.id === meta.id && r.committedRevision === meta.revision && r.final,
    ),
  );
  const stored = good("storage/writeChunk").filter((r) => r.params.write === write);
  assert.equal(stored.length, 1);
  assert.equal("drainToken" in stored[0].params, false, "Chunk uses the original write handle");
  const bytes = Buffer.from(stored[0].params.data, "base64");
  assert.equal(hash(bytes), meta.sha256);
  assert.equal(bytes.length, meta.byteLength);
  const stat = good("storage/stat").at(-1);
  assert.deepEqual(ok(stat).record, meta);
  const pinned = good("storage/openRead").find((r) => r.params.expectedRevision === meta.revision);
  assert.ok(pinned);
  assert.equal(pinned.params.id, meta.id);
  const read = good("storage/readChunk").find((r) => r.params.read === ok(pinned).read);
  assert.ok(read);
  assert.equal(ok(read).eof, true);
  assert.equal(hash(Buffer.from(ok(read).data, "base64")), meta.sha256);
  const copies = p("ui/copyText");
  assert.equal(copies.length, 3);
  bad(copies[0], "PLUGIN_E_PERMISSION_DENIED");
  assert.equal(ok(copies[1]).copied, true);
  bad(copies[2], "PLUGIN_E_PERMISSION_DENIED");
  assert.equal(copies[1].params.actionRef, copies[2].params.actionRef);
  const action = pairs(report, ownerId, "command/invoke", "host-plugin").find(
    (r) => r.params.command === ownerId + ".copy",
  );
  assert.ok(action);
  assert.equal(action.params.context.actionRef, copies[1].params.actionRef);
  assert.equal(action.params.context.origin, "panel");
  assert.deepEqual(action.params.context.binding, report.checkpoints.binding);
  assert.equal(report.checkpoints.copy.text, copies[1].params.text);
  ok(action);
  const exportReject = p("storage/exportBegin");
  assert.equal(exportReject.length, 1);
  bad(exportReject[0], "PLUGIN_E_PERMISSION_DENIED");
  assert.ok(
    report.logs.some(
      (line) =>
        line.startsWith("STDIO_RESULT:") &&
        JSON.parse(line.slice(13)).missing_action_ref_local === 2,
    ),
  );
  for (const c of [report.cleanup.bridge, report.cleanup.worker])
    for (const n of Object.values(c)) assert.equal(n, 0);
  assert.equal(report.cleanup.workers, 0);
  return {
    record: meta,
    checkpoint,
    reservation,
    finalWrite: write,
    dataSha256: committed.sha256,
    claim: report.claim,
  };
}

export async function buildStdio(directory, python) {
  const require = createRequire(import.meta.url),
    { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([key, [file]]) => [
      key,
      path.join(root, file),
    ]),
  );
  const sources = new Set(
    [
      "tests/desktop/sensor-lab-stdio-run.mjs",
      "tests/desktop/sensor-lab-stdio-test.mjs",
      "tests/desktop/builtin-installed-client.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
      "tests/desktop/fixtures/sensor-lab-public/consumer.py",
    ].map((p) => path.join(root, p)),
  );
  const artifactHashes = {};
  for (const [name, contents] of [
    [
      "main.cjs",
      `import {runStdio} from ${JSON.stringify(path.join(root, "tests/desktop/sensor-lab-stdio-main.ts"))};runStdio();`,
    ],
    [
      "worker.cjs",
      `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))};runShippedPersistenceWorker();`,
    ],
  ]) {
    const result = await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      outfile: path.join(directory, name),
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
      external: ["electron", "node-hid", "usb"],
      plugins: [rawResourcePlugin()],
      metafile: true,
    });
    for (const input of Object.keys(result.metafile.inputs))
      if (input !== "<stdin>")
        sources.add(
          input.startsWith("kobrixa-raw-resource:") ? input.slice(21) : path.resolve(root, input),
        );
    await writeFile(
      path.join(directory, name + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
    artifactHashes[name] = hash(await readFile(path.join(directory, name)));
  }
  await mkdir(path.join(directory, "profile"));
  await mkdir(path.join(directory, "python"));
  await cp(path.join(root, "sdks/python/kobrixa"), path.join(directory, "python/kobrixa"), {
    recursive: true,
    filter: (p) => !p.includes("__pycache__"),
  });
  for (const file of await readdir(path.join(directory, "python/kobrixa"))) {
    artifactHashes["python/kobrixa/" + file] = hash(
      await readFile(path.join(directory, "python/kobrixa", file)),
    );
    sources.add(path.join(root, "sdks/python/kobrixa", file));
  }
  for (const role of ["owner", "foreign", "denied"]) {
    const folder = path.join(directory, role);
    await mkdir(folder);
    const { manifest, panel, status } = documents(role);
    await writeFile(path.join(folder, "kobrixa-plugin.json"), JSON.stringify(manifest));
    await cp(
      path.join(root, "tests/desktop/fixtures/sensor-lab-public/consumer.py"),
      path.join(folder, "consumer.py"),
    );
    if (role === "owner") await writeFile(path.join(folder, "panel.json"), JSON.stringify(panel));
    else await writeFile(path.join(folder, "status.json"), JSON.stringify(status));
    for (const file of await readdir(folder))
      artifactHashes[role + "/" + file] = hash(await readFile(path.join(folder, file)));
  }
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ python }));
  artifactHashes["config.json"] = hash(await readFile(path.join(directory, "config.json")));
  const sourceHashes = {};
  for (const file of sources) sourceHashes[file] = hash(await readFile(file));
  const identity = {
    claim: "synthetic-python-stdio-parity",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    artifactHashes,
    sourceHashes,
    python,
  };
  await writeFile(path.join(directory, "identity.json"), JSON.stringify(identity, null, 2));
  return identity;
}
export async function resolvePython(explicit, env = process.env, platform = process.platform) {
  const command =
    explicit || env.KOBRIXA_TEST_PYTHON || (platform === "win32" ? "python" : "python3");
  return realpath(
    execFileSync(command, ["-c", "import sys;print(sys.executable)"], {
      encoding: "utf8",
    }).trim(),
  );
}
async function main(args) {
  assert.ok(["--build-only", "--run-built", "--run"].includes(args[0]));
  if (args[0] !== "--run-built") {
    const python = await resolvePython(args[1]);
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-lab-stdio-")));
    await buildStdio(directory, python);
    if (args[0] === "--build-only") {
      console.log(`BUILD ONLY, no Electron: ${directory}`);
      return;
    }
    console.log(`Stdio artifacts: ${directory}`);
    const electron = createRequire(path.join(root, "apps/desktop/package.json"))("electron");
    return main(["--run-built", directory, electron]);
  }
  const directory = await realpath(args[1]),
    identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
  for (const [file, h] of Object.entries(identity.sourceHashes))
    assert.equal(hash(await readFile(file)), h, `Changed source ${file}`);
  for (const [file, h] of Object.entries(identity.artifactHashes))
    assert.equal(hash(await readFile(path.join(directory, file))), h, file);
  assert.deepEqual(await readdir(path.join(directory, "profile")), []);
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [path.join(directory, "main.cjs"), `--stdio-root=${directory}`],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    timedOut = false;
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  const known = new Set(),
    monitorErrors = [];
  let pending = Promise.resolve();
  const monitor = setInterval(() => {
    pending = pending.then(async () => {
      try {
        descendants(await processTable(), child.pid, known);
      } catch (e) {
        monitorErrors.push(String(e));
      }
    });
  }, 50);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120000);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
    await pending;
    await writeFile(path.join(directory, "native.log"), output);
  }
  const survivors = descendants(await processTable(), child.pid, known);
  await writeFile(
    path.join(directory, "process.json"),
    JSON.stringify({ result, timedOut, survivors, monitorErrors }, null, 2),
  );
  for (const row of survivors)
    try {
      process.kill(row.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  assert.equal(timedOut, false);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(survivors, []);
  assert.deepEqual(monitorErrors, []);
  const raw = await readFile(path.join(directory, "producer.json"));
  const receipt = verifyStdio(JSON.parse(raw));
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify({ receipt, producerSha256: hash(raw), identity }, null, 2),
  );
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
