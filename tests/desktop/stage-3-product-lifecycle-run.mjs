import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLab } from "./sensor-lab-public-run.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { processTable, descendants } from "./builtin-installed-client.mjs";
import { createProcessMonitor, finishProcessObservation } from "./device-ui-stdio-run.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const features = ["motor-test", "sensor-lab", "device-ev3"];
export const events = [
  "hide",
  "close",
  "blur",
  "minimize",
  "window-hide",
  "suspend-wake",
  "provider-loss",
  "provider-disable",
  "provider-replacement",
  "renderer-freeze",
  "renderer-crash",
  "window-destroyed",
  "consumer-kill",
  "feature-disable",
];
export const cases = [
  ...features.flatMap((feature) =>
    events.map((event) => ({ id: `${feature}/${event}`, feature, event })),
  ),
  ...[
    "independent-toggles",
    "all-off",
    "cold-safe",
    "optional-unclean",
    "renderer-unclean",
    "third-party-unclean",
    "device-kill-lab-recording",
  ].map((event) => ({ id: event, feature: "sensor-lab", event })),
];

export async function buildLifecycle(directory) {
  // Reuse the real generic renderer, preload, worker and Lab payload builder unchanged.
  const identity = await buildLab(directory);
  const require = createRequire(import.meta.url);
  const { build } = require("esbuild");
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([key, [value]]) => [
      key,
      path.join(root, value),
    ]),
  );
  const bundle = async (entry, output, prefix = "") => {
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
      external: ["electron", "node-hid", "usb"],
      plugins: [rawResourcePlugin()],
      metafile: true,
      stdin: {
        contents: `${prefix}\nimport ${JSON.stringify(path.join(root, entry))};`,
        resolveDir: root,
        loader: "ts",
      },
      outfile: path.join(directory, output),
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === "<stdin>") continue;
      const file = input.startsWith("kobrixa-raw-resource:")
        ? input.slice("kobrixa-raw-resource:".length)
        : path.resolve(root, input);
      identity.sourceHashes[path.relative(root, file).split(path.sep).join("/")] = hash(
        await readFile(file),
      );
    }
  };
  await bundle("tests/desktop/stage-3-product-lifecycle-main.ts", "main.cjs");
  for (const slug of ["motor-test", "device-ev3"]) {
    const leaf = path.join(directory, "plugins", slug);
    await mkdir(leaf, { recursive: true });
    const source = `plugins/${slug}`;
    const manifest = JSON.parse(
      await readFile(path.join(root, source, "kobrixa-plugin.json"), "utf8"),
    );
    const resources = [
      "kobrixa-plugin.json",
      ...["panels", "status"].flatMap((kind) =>
        (manifest.contributes[kind] ?? []).map((row) => row.resource.path),
      ),
      ...(manifest.contributes.settings ? [manifest.contributes.settings.path] : []),
    ];
    await bundle(
      `${source}/src/main.ts`,
      `plugins/${slug}/main.cjs`,
      'console.error("LIFECYCLE_PID:" + process.pid);',
    );
    for (const name of resources) {
      await mkdir(path.dirname(path.join(leaf, name)), { recursive: true });
      await cp(path.join(root, source, name), path.join(leaf, name));
      identity.sourceHashes[`${source}/${name}`] = hash(
        await readFile(path.join(root, source, name)),
      );
    }
    const files = [];
    for (const name of [...resources, "main.cjs"].sort()) {
      const bytes = await readFile(path.join(leaf, name));
      files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
    await writeFile(
      path.join(leaf, "resource-index.json"),
      JSON.stringify({ version: 1, pluginId: manifest.id, files }),
    );
  }
  for (const name of [
    "stage-3-product-lifecycle-run.mjs",
    "stage-3-product-lifecycle.test.mjs",
    "builtin-installed-client.mjs",
    "device-ui-stdio-run.mjs",
  ])
    identity.sourceHashes[`tests/desktop/${name}`] = hash(
      await readFile(path.join(root, "tests/desktop", name)),
    );
  for (const name of await readdir(directory, { recursive: true })) {
    if (
      (/^(renderer|plugins)[/\\]/.test(name) && /\.(json|cjs|js|css|html)$/.test(name)) ||
      name === "main.cjs"
    )
      identity.artifactHashes[name.split(path.sep).join("/")] = hash(
        await readFile(path.join(directory, name)),
      );
  }
  identity.scope =
    "acceptance-host / actual shipped consumers / synthetic provider / generic renderer";
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return identity;
}

function successfulPairs(report, method) {
  return report.wire
    .filter((r) => r.direction === "plugin-host" && r.message.method === method)
    .flatMap((request) => {
      const replies = report.wire.filter(
        (r) =>
          r.direction === "host-plugin" &&
          r.sequence > request.sequence &&
          r.message.id === request.message.id &&
          !r.message.method &&
          JSON.stringify(r.owner) === JSON.stringify(request.owner),
      );
      assert.ok(replies.length <= 1, `Duplicate original reply: ${method}`);
      return replies[0]?.message.result?.ok
        ? [{ request, response: replies[0], value: replies[0].message.result.value }]
        : [];
    });
}
export function verifyLifecycleCase(report, spec) {
  assert.equal(report.schema, 1);
  assert.equal(report.id, spec.id);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.ok(report.versions.electron);
  assert.ok(report.mainPid > 0);
  assert.equal(report.scope, "acceptance-host");
  assert.equal(report.syntheticProvider, true);
  const cp = report.checkpoints;
  assert.ok(cp.idle.sequence < cp.finished.sequence);
  assert.equal(cp.idle.launches.length, 0, "No idle executable activation");
  assert.deepEqual(cp.idle.providerSteps, [], "No idle device I/O");
  assert.equal(report.cleanup.workers, 0);
  assert.equal(report.launches.length, report.exits.length, "No surviving consumer process");
  for (const launch of report.launches) {
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0 && launch.pid !== report.mainPid);
    assert.ok(report.exits.some((r) => JSON.stringify(r.owner) === JSON.stringify(launch.owner)));
  }
  let lastSequence = 0;
  for (const row of report.wire) {
    assert.ok(row.sequence > lastSequence, "Original RPC ordering");
    lastSequence = row.sequence;
    assert.ok(
      report.launches.some((launch) => JSON.stringify(launch.owner) === JSON.stringify(row.owner)),
      "Original launched channel owner",
    );
  }
  if (events.includes(spec.event)) {
    assert.ok(
      cp.active.sequence < cp.injected.sequence && cp.injected.sequence < cp.settled.sequence,
    );
    const original = cp.active.owner;
    assert.equal(original.pluginId, `kobrixa.${spec.feature}`);
    const before = (method) =>
      successfulPairs(report, method).filter(
        (p) =>
          p.request.sequence < cp.injected.sequence &&
          p.request.owner.pluginId === original.pluginId,
      );
    const after = (method) =>
      successfulPairs(report, method).filter(
        (p) =>
          p.request.sequence > cp.injected.sequence &&
          p.request.sequence <= cp.settled.sequence &&
          p.request.owner.pluginId === original.pluginId,
      );
    if (spec.feature === "device-ev3") {
      const subscriptions = before("devices/subscribe");
      assert.ok(subscriptions.length, "Original device observer subscription");
      if (["hide", "close"].includes(spec.event)) {
        const removed = after("events/unsubscribe");
        assert.ok(
          removed.some(
            (r) =>
              r.value.removed === true &&
              subscriptions.some(
                (s) => s.value.subscriptionId === r.request.message.params.subscriptionId,
              ),
          ),
          "Hide/close disposes actual device observation",
        );
      }
    }
    for (const method of ["devices/motion/start", "devices/recording/reserve"]) {
      assert.equal(
        successfulPairs(report, method).filter(
          (p) =>
            p.request.sequence > cp.injected.sequence && p.request.sequence <= cp.finished.sequence,
        ).length,
        0,
        `No replay through restoration/reopen: ${method}`,
      );
    }
    if (spec.feature === "sensor-lab") {
      assert.equal(before("devices/recording/reserve").length, 1);
      assert.ok(before("storage/registerCheckpoint").length);
      if (
        ["hide", "close", "blur", "minimize", "window-hide", "renderer-freeze"].includes(spec.event)
      ) {
        assert.ok(
          after("devices/recording/read").some((p) => p.value.frames.length > 0),
          "Live background frames after injection",
        );
        assert.equal(after("devices/recording/release").length, 0);
        assert.ok(
          cp.settled.reservations.some((r) => r.current),
          "Background reservation remains valid",
        );
      } else if (spec.event !== "consumer-kill") {
        const drain = report.drains.find(
          (d) =>
            d.sequence > cp.injected.sequence &&
            d.sequence <= cp.settled.sequence &&
            d.offer.owner.pluginId === original.pluginId,
        );
        assert.ok(
          drain?.report && drain.report.state === "saved" && !drain.report.blocker,
          "Actual bounded final save",
        );
        assert.ok(drain.report.records.some((r) => r.final && r.committedRevision));
        assert.ok(
          drain.offer.deadlineMonotonicMs - drain.startedMonotonicMs <= 10_000,
          "Original bounded drain grant",
        );
        assert.ok(
          drain.finishedMonotonicMs <= drain.offer.deadlineMonotonicMs,
          "Save within original deadline",
        );
        assert.ok(
          successfulPairs(report, "storage/commitWrite").some(
            (p) =>
              p.request.message.params.drainToken === drain.offer.token &&
              p.value.record.checkpoint === "final",
          ),
          "Original final commit reply",
        );
        if (["renderer-crash", "window-destroyed", "feature-disable"].includes(spec.event)) {
          const exit = report.exits.find(
            (r) => JSON.stringify(r.owner) === JSON.stringify(original),
          );
          assert.ok(
            exit && drain.finishedSequence < exit.sequence,
            "Save precedes process termination",
          );
        }
      }
      if (
        !["hide", "close", "blur", "minimize", "window-hide", "renderer-freeze"].includes(
          spec.event,
        )
      ) {
        const reservation = before("devices/recording/reserve")[0].value.reservation.reservationId;
        assert.ok(
          report.ended.some(
            (r) =>
              r.event.reservationId === reservation &&
              r.sequence > cp.injected.sequence &&
              r.sequence <= cp.settled.sequence,
          ),
          "Host ended original reservation",
        );
        assert.equal(
          cp.settled.reservations.find((r) => r.reservationId === reservation)?.current,
          null,
          "Ended reservation cannot be revived",
        );
        if (spec.event === "consumer-kill") {
          const registered = before("storage/registerCheckpoint")[0].request.message.params;
          assert.ok(
            report.lost.some(
              (r) =>
                r.owner.pluginId === original.pluginId &&
                r.report?.state === "checkpoint-only" &&
                r.report.records.some(
                  (record) =>
                    record.id === registered.id &&
                    record.committedRevision === registered.expectedRevision &&
                    !record.final,
                ),
            ),
            "Killed recorder preserves only original committed checkpoint",
          );
        }
      }
      assert.equal(after("devices/recording/reserve").length, 0, "No automatic recording replay");
    }
    if (spec.feature === "motor-test") {
      assert.ok(before("devices/motion/start").length, "Original motion admission");
      assert.ok(
        report.providerTrace.some(
          (r) =>
            r.step === "stop" &&
            r.sequence > cp.injected.sequence &&
            r.sequence <= cp.settled.sequence,
        ),
        "Host stop exchange after injection",
      );
      assert.equal(after("devices/motion/start").length, 0, "No automatic motion replay");
    }
    const retires =
      ["renderer-crash", "window-destroyed", "consumer-kill", "feature-disable"].includes(
        spec.event,
      ) ||
      (spec.feature === "device-ev3" &&
        ["provider-disable", "provider-replacement"].includes(spec.event));
    if (!retires) {
      assert.deepEqual(
        cp.settled.owner,
        original,
        "Healthy generation survives reservation/provider end",
      );
      assert.ok(
        !report.exits.some(
          (r) =>
            r.sequence <= cp.settled.sequence &&
            JSON.stringify(r.owner) === JSON.stringify(original),
        ),
      );
    }
    if (retires)
      assert.ok(
        report.exits.some(
          (r) =>
            r.sequence <= cp.settled.sequence &&
            JSON.stringify(r.owner) === JSON.stringify(original),
        ),
        "Retired process actually exited",
      );
    if (
      [
        "provider-loss",
        "provider-disable",
        "provider-replacement",
        "feature-disable",
        "suspend-wake",
      ].includes(spec.event)
    ) {
      assert.ok(
        cp.settled.sequence < cp.beforeRestore.sequence &&
          cp.beforeRestore.sequence < cp.restored.sequence &&
          cp.restored.sequence < cp.finished.sequence,
      );
      assert.equal(
        cp.restored.launches.length,
        cp.beforeRestore.launches.length,
        "Restoring availability cannot activate a process",
      );
    }
    if (["renderer-crash", "consumer-kill"].includes(spec.event)) {
      assert.equal(
        cp.beforeReopen.launches.length,
        cp.settled.launches.length,
        "Reload cannot launch a consumer",
      );
      assert.ok(
        cp.reopened.owner.generation > original.generation ||
          cp.reopened.owner.processEpoch !== original.processEpoch,
      );
      assert.notEqual(cp.reopened.binding.panelInstance, cp.active.binding.panelInstance);
      const opening = cp.explicitOpen;
      assert.ok(
        opening.sequence > cp.beforeReopen.sequence &&
          opening.finishedSequence < cp.reopened.sequence,
      );
      assert.equal(opening.result.ok, true);
      assert.deepEqual(opening.result.value.binding, cp.reopened.binding);
      assert.ok(
        report.launches.some(
          (r) =>
            r.sequence > opening.sequence &&
            r.sequence < opening.finishedSequence &&
            JSON.stringify(r.owner) === JSON.stringify(cp.reopened.owner),
        ),
        "New process launched only inside explicit open",
      );
      assert.equal(cp.originalBinding.result.ok, true, "Binding worked before retirement");
      assert.equal(cp.stale.result.ok, false, "Old binding cannot invoke again");
      const late = cp.lateCallback;
      assert.ok(late.sequence > cp.settled.sequence);
      const patch = successfulPairs(report, "ui/patch").find(
        (p) => p.request.sequence === late.originalSequence,
      );
      assert.ok(
        patch && patch.response.sequence < cp.injected.sequence,
        "Replay is an originally accepted patch",
      );
      assert.deepEqual(late.message, patch.request.message);
      assert.deepEqual(late.owner, original);
      assert.equal(late.result.ok, false, "Late callback cannot revive old binding");
      assert.deepEqual(late.instances, [], "No old panel or status revived");
    }
    if (spec.event === "close") {
      assert.deepEqual(cp.reopened.owner, original, "Closing a panel preserves healthy process");
      assert.notEqual(cp.reopened.binding.panelInstance, cp.active.binding.panelInstance);
    }
    if (spec.event === "renderer-freeze") {
      assert.ok(
        report.native.some(
          (r) => r.event === "Debugger.paused" && r.sequence > cp.injected.sequence,
        ),
      );
      assert.ok(
        !report.native.some(
          (r) =>
            ["Debugger.resumed", "detach"].includes(r.event) &&
            r.sequence > cp.injected.sequence &&
            r.sequence < cp.settled.sequence,
        ),
      );
    }
  } else if (
    [
      "cold-safe",
      "renderer-unclean",
      "third-party-unclean",
      "all-off",
      "optional-unclean",
    ].includes(spec.event)
  ) {
    assert.equal(cp.finished.state.safeMode, !["all-off", "optional-unclean"].includes(spec.event));
    for (const id of ["kobrixa.basic-plus", "kobrixa.ev3"]) {
      const required = cp.finished.state.plugins.find((p) => p.id === id);
      assert.ok(required?.required && required.enabled, "Required compiler remains enabled");
    }
    if (spec.event === "all-off" || spec.event === "optional-unclean") {
      for (const feature of features)
        assert.equal(
          cp.finished.state.plugins.find((p) => p.id === `kobrixa.${feature}`)?.enabled,
          spec.event === "optional-unclean",
        );
    }
    if (spec.event.endsWith("unclean")) {
      assert.equal(cp.seedMarker.rendererUnresponsive, spec.event === "renderer-unclean");
      assert.equal(cp.seedMarker.thirdPartyUiContributions, spec.event === "third-party-unclean");
      assert.equal(cp.seedMarker.thirdPartyRunning, false);
    }
    assert.deepEqual(cp.finished.launches, []);
    assert.deepEqual(cp.finished.providerSteps, []);
    if (spec.event !== "optional-unclean") {
      assert.deepEqual(cp.finished.catalog.entries, []);
      assert.equal(cp.finished.providersCreated, 0, "Suppressed provider factory");
      assert.deepEqual(cp.finished.importGates, [], "Suppressed optional import gates");
    }
  } else if (spec.event === "independent-toggles") {
    assert.equal(report.toggles.length, 6);
    for (const row of report.toggles) {
      assert.equal(row.result.ok, true);
      for (const slug of features) {
        const actual = row.state.plugins.find((p) => p.id === `kobrixa.${slug}`);
        assert.ok(actual);
        assert.equal(actual.enabled, slug === row.feature ? row.enabled : true);
      }
    }
  } else if (spec.event === "device-kill-lab-recording") {
    assert.deepEqual(cp.active.owner, cp.settled.owner);
    assert.ok(
      successfulPairs(report, "devices/recording/read").some(
        (p) =>
          p.request.sequence > cp.injected.sequence &&
          p.request.sequence <= cp.settled.sequence &&
          p.value.frames.length,
      ),
    );
    assert.equal(successfulPairs(report, "devices/recording/reserve").length, 1);
    assert.equal(
      cp.active.providersCreated,
      cp.settled.providersCreated,
      "UI crash must not replace provider",
    );
    assert.ok(
      report.exits.some(
        (r) =>
          r.owner.pluginId === "kobrixa.device-ev3" &&
          r.sequence > cp.injected.sequence &&
          r.sequence <= cp.settled.sequence,
      ),
      "Device UI actually exited",
    );
    assert.ok(
      !report.exits.some(
        (r) => r.owner.pluginId === "kobrixa.sensor-lab" && r.sequence <= cp.settled.sequence,
      ),
    );
  }
  return spec.id;
}

export function verifyLifecycleReceipt(receipt) {
  assert.equal(receipt.schema, 1);
  assert.equal(receipt.scope, "W18a");
  assert.equal(receipt.results.length, cases.length, "A partial selection is not full acceptance");
  assert.equal(new Set(receipt.results.map((r) => r.id)).size, cases.length);
  assert.ok(receipt.identity.sourceHashes["tests/desktop/stage-3-product-lifecycle-main.ts"]);
  for (const slug of features)
    assert.match(receipt.identity.artifactHashes[`plugins/${slug}/main.cjs`], /^[0-9a-f]{64}$/);
  for (const spec of cases)
    verifyLifecycleCase(
      receipt.results.find((r) => r.id === spec.id),
      spec,
    );
  assert.equal(receipt.processObservations.length, cases.length);
  assert.equal(new Set(receipt.processObservations.map((r) => r.id)).size, cases.length);
  for (const observation of receipt.processObservations) {
    assert.ok(cases.some((spec) => spec.id === observation.id));
    assert.deepEqual(observation.errors, []);
    assert.deepEqual(observation.survivors, []);
    assert.deepEqual(observation.result, { code: 0, signal: null });
    assert.equal(observation.timedOut, false);
    assert.equal(observation.outputOverflow, false);
    const report = receipt.results.find((r) => r.id === observation.id);
    for (const launch of report.launches)
      assert.ok(
        observation.samples.some((sample) =>
          sample.rows.some((row) => row.pid === launch.pid && row.ppid === report.mainPid),
        ),
        "OS observed actual utility process parentage",
      );
  }
  assert.match(receipt.electronSha256, /^[0-9a-f]{64}$/);
  return cases.length;
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(
    args.every((arg) => ["--run", "--build-only", "--inventory"].includes(arg)),
    "Use --run, --build-only, or --inventory",
  );
  if (args.includes("--inventory") || args.length === 0) {
    console.log(
      JSON.stringify(
        { scope: "acceptance-host; no hardware/installed-product claims", cases },
        null,
        2,
      ),
    );
    return;
  }
  assert.notEqual(args.includes("--run"), args.includes("--build-only"));
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-w18a-"));
  console.log(`W18a artifacts: ${directory}`);
  const identity = await buildLifecycle(directory);
  if (args.includes("--build-only")) return;
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const electron = require("electron");
  const results = [];
  const processObservations = [];
  for (const spec of cases) {
    const run = path.join(directory, "runs", spec.id.replaceAll("/", "-"));
    await mkdir(path.join(run, "profile"), { recursive: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      [
        path.join(directory, "main.cjs"),
        `--lifecycle-root=${directory}`,
        `--lifecycle-run=${run}`,
        `--lifecycle-feature=${spec.feature}`,
        `--lifecycle-event=${spec.event}`,
        `--lifecycle-id=${spec.id}`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      timedOut = false,
      outputOverflow = false;
    const capture = (bytes) => {
      if (Buffer.byteLength(output) + bytes.length > 4 * 1024 * 1024) {
        outputOverflow = true;
        child.kill("SIGKILL");
        return;
      }
      output += bytes;
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const known = new Map(),
      errors = [],
      samples = [];
    const monitor = createProcessMonitor({
      poll: processTable,
      observe: (rows) => {
        const owned = descendants(rows, child.pid, known);
        samples.push({ at: Date.now(), rows: owned });
      },
      onError: (error) => errors.push(String(error)),
    });
    monitor.tick();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 90_000);
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
      await writeFile(path.join(run, "native.log"), output);
    }
    const survivors = await finishProcessObservation({
      poll: processTable,
      parent: child.pid,
      known,
      onError: (error) => errors.push(String(error)),
    });
    const processObservation = {
      id: spec.id,
      result,
      timedOut,
      outputOverflow,
      errors,
      survivors,
      samples,
    };
    await writeFile(path.join(run, "process.json"), JSON.stringify(processObservation, null, 2));
    assert.equal(timedOut, false, `Native timeout; see ${run}`);
    assert.equal(outputOverflow, false);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      survivors,
      [],
      "No descendants after process exit; forced cleanup cannot count as passing",
    );
    assert.deepEqual(
      result,
      { code: 0, signal: null },
      `Native ${spec.id} failed; see ${run}/native.log and producer.json`,
    );
    const report = JSON.parse(await readFile(path.join(run, "producer.json"), "utf8"));
    verifyLifecycleCase(report, spec);
    results.push(report);
    processObservations.push(processObservation);
    await writeFile(
      path.join(directory, "receipt.partial.json"),
      JSON.stringify({ schema: 1, scope: "W18a", identity, results }, null, 2),
    );
  }
  // Reject concurrent source/artifact changes: the orchestrator must measure a frozen candidate.
  for (const [name, expected] of Object.entries(identity.sourceHashes))
    assert.equal(
      hash(await readFile(path.resolve(root, name))),
      expected,
      `Source changed during run: ${name}`,
    );
  for (const [name, expected] of Object.entries(identity.artifactHashes))
    assert.equal(
      hash(await readFile(path.join(directory, name))),
      expected,
      `Artifact changed during run: ${name}`,
    );
  const receipt = {
    schema: 1,
    scope: "W18a",
    identity,
    results,
    processObservations,
    electronSha256: hash(await readFile(electron)),
    platform: process.platform,
    arch: process.arch,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
  verifyLifecycleReceipt(receipt);
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`STAGE3_PRODUCT_LIFECYCLE_RECEIPT=${path.join(directory, "receipt.json")}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
