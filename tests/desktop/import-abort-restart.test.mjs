import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function host(root, mode, config) {
  const lease = randomUUID(),
    lock = path.join(root, "host.lock");
  await writeFile(lock, lease, { flag: "wx" });
  const child = fork(
    new URL(
      mode.startsWith("plan-")
        ? "./support/import-plan-host.mjs"
        : "./support/import-restart-host.mjs",
      import.meta.url,
    ),
    [root, mode, lease, JSON.stringify(config)],
    { silent: true, execArgv: process.execArgv.filter((x) => !x.startsWith("--test")) },
  );
  let stderr = "",
    armed,
    result;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (msg) => {
        if (msg.kind === "armed") armed = msg;
        else if (msg.kind === "cut") {
          result = msg;
          child.kill("SIGKILL");
        } else result = msg;
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if ((mode === "matrix" || mode === "plan-write") && !config.cut) {
      assert.equal(exit.code, 0, stderr);
      assert.equal(result.kind, "reference");
      return;
    }
    if (mode === "write" || mode === "seed" || mode === "matrix" || mode === "plan-write") {
      assert.ok(armed && result?.kind === "cut", "missed writer cut " + stderr);
      assert.deepEqual(exit, { code: null, signal: "SIGKILL" });
      if (mode === "matrix") {
        assert.equal(armed.cut, config.cut);
        assert.equal(armed.ticket.id, config.ticket.id);
        assert.equal(result.point, config.cut);
        assert.equal(result.event.point, config.cut);
        if (result.event.diskPath)
          assert.ok(path.relative(root, result.event.diskPath).startsWith("plugins" + path.sep));
        assert.equal(result.ticket.target.id, config.ticket.target.id);
      } else {
        assert.equal(result.ticket, armed.ticket.id);
        if (mode === "plan-write") assert.equal(result.point, config.cut);
        else assert.ok(config.points.includes(result.point));
      }
      return { ...armed, cut: result };
    }
    assert.equal(exit.code, 0, stderr);
    assert.equal(result.kind, "complete");
    return result;
  } finally {
    clearTimeout(timer);
    await rm(lock);
  }
}
for (const [failure, points] of [
  ["object-rename", ["abort/unlink/stage/payload.tmp"]],
  ["before-publish", ["abort/unlink/record/object", "abort/atomicReplace/quarantine/object"]],
]) {
  test("fresh host at the last payload edge after " + failure, async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "abort-restart-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "legacy"));
    const originals = ["sibling", "target"].map((value) =>
      Buffer.from(JSON.stringify({ formatVersion: 1, value })),
    );
    for (const [i, bytes] of originals.entries())
      await writeFile(path.join(root, "legacy", "item" + i), bytes);
    await writeFile(path.join(root, "fault"), "record-steps");
    const interrupted = await host(root, "write", { failure, points });
    const ns = path.join(
      root,
      "plugins",
      "persistence-v1",
      "namespaces",
      createHash("sha256").update(interrupted.ticket.owner.sourceKey).digest("hex"),
    );
    // Inspect the stopped writer before startup can classify or mutate these bytes.
    const sibling = path.join(ns, "records", interrupted.sibling.target.id);
    const siblingHead = JSON.parse(await readFile(path.join(sibling, "head.json")));
    assert.equal(siblingHead.receipt.commitId, interrupted.sibling.id);
    assert.deepEqual(
      await readFile(path.join(sibling, "objects", siblingHead.object)),
      originals[0],
    );
    for (const [i, bytes] of originals.entries())
      assert.deepEqual(await readFile(path.join(root, "legacy", "item" + i)), bytes);
    const journalKey = createHash("sha256").update(interrupted.plan.id).digest("hex");
    const progress = JSON.parse(await readFile(path.join(ns, "imports", journalKey + ".json")));
    const journalBytes = await readFile(path.join(ns, "imports", "objects", progress.object));
    assert.equal(createHash("sha256").update(journalBytes).digest("hex"), progress.sha256);
    const journal = JSON.parse(journalBytes);
    assert.deepEqual(journal.plan, interrupted.plan);
    assert.equal(journal.items[0].receipt.commitId, interrupted.sibling.id);
    assert.equal(journal.items[1].state, "pending");
    assert.equal(journal.items[1].receipt, null);
    assert.deepEqual(journal.items[1].publicationTicket, interrupted.ticket);
    const record = path.join(ns, "records", interrupted.ticket.target.id);
    const names = await readdir(record);
    assert.ok(!names.includes("head.json"));
    t.diagnostic(
      JSON.stringify({
        point: interrupted.cut.point,
        names,
        objects: await readdir(path.join(record, "objects")),
        quarantine: await readdir(path.join(ns, "quarantine")),
      }),
    );
    const retry = await host(root, "retry", interrupted);
    assert.notEqual(retry.epoch, interrupted.cut.epoch);
    const replay = await host(root, "replay", { ...interrupted, ticket: retry.ticket });
    assert.notEqual(replay.epoch, retry.epoch);
    for (const [i, bytes] of originals.entries())
      assert.deepEqual(await readFile(path.join(root, "legacy", "item" + i)), bytes);
  });
}

async function makeProfile(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "import-cuts-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("fresh host reconciles a surviving record head before the writer receives its receipt", async (t) => {
  const root = await makeProfile(t);
  await mkdir(path.join(root, "legacy"));
  for (const i of [0, 1])
    await writeFile(path.join(root, "legacy", "item" + i), JSON.stringify({ formatVersion: 1, i }));
  await writeFile(path.join(root, "fault"), "record-steps");
  const stopped = await host(root, "write", { points: ["publish/atomicReplace/record/head.json"] });
  const first = await host(root, "published", stopped);
  const replay = await host(root, "replay", stopped);
  assert.deepEqual(first.ticket, stopped.ticket);
  assert.deepEqual(replay.ticket, stopped.ticket);
  assert.notEqual(first.epoch, stopped.ticket.owner.hostEpoch);
  assert.notEqual(replay.epoch, first.epoch);
});

async function matrixTrial(t, seed, options, cut) {
  const root = await makeProfile(t);
  await cp(seed.root, root, { recursive: true });
  const run = await host(root, "matrix", { ...options, plan: seed.plan, ticket: seed.ticket, cut });
  const trace = (await readFile(path.join(root, "cut-trace"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(trace.every((e) => e.target === seed.ticket.target.id));
  return { root, trace, run };
}

function assertAbortOrder(points) {
  let previous = -1;
  for (const step of [
    "atomicReplace/stage/abort-tag.json#1",
    "syncDirectory/stage#1",
    "quota-holdTemporary#1",
    "atomicReplace/quarantine/object#1",
    "syncDirectory/quarantine#1",
    "syncDirectory/record/objects#1",
    "atomicReplace/quarantine/candidate#1",
    "syncDirectory/quarantine#2",
    "syncDirectory/record#1",
    "unlink/quarantine/object#1",
    "syncDirectory/quarantine#3",
    "unlink/quarantine/candidate#1",
    "syncDirectory/quarantine#4",
    "removeEmpty/stage#1",
    "quota-commit#1",
    "quota-releaseTemporary#1",
  ])
    for (const edge of ["before", "after"]) {
      const index = points.indexOf("removeUnpublished/" + edge + "/" + step);
      assert.ok(index > previous, edge + "/" + step);
      previous = index;
    }
  for (const method of ["holdTemporary", "releaseTemporary"])
    for (const edge of ["before", "after"])
      assert.equal(
        points.filter((p) => p.startsWith(`removeUnpublished/${edge}/quota-${method}#`)).length,
        1,
      );
}

test("orders installed abort barriers and releases one hold", async (t) => {
  const root = await makeProfile(t);
  await mkdir(path.join(root, "legacy"));
  for (const [i, value] of ["sibling", "target"].entries())
    await writeFile(
      path.join(root, "legacy", "item" + i),
      JSON.stringify({ formatVersion: 1, value }),
    );
  await writeFile(path.join(root, "fault"), "record-steps");
  const seed = { ...(await host(root, "seed", { points: ["pending"] })), root };
  const { trace } = await matrixTrial(t, seed, { failure: "before-publish" }, null);
  assertAbortOrder(trace.map((e) => e.point));
});

test("process interruptions across first import, abort and restarted cleanup", async (t) => {
  const root = await makeProfile(t);
  await mkdir(path.join(root, "legacy"));
  const originals = ["a", "b"].map((v, i) =>
    Buffer.from(JSON.stringify({ formatVersion: 1, value: v.repeat(i ? 270000 : 32) })),
  );
  for (const [i, bytes] of originals.entries())
    await writeFile(path.join(root, "legacy", "item" + i), bytes);
  await writeFile(path.join(root, "fault"), "record-steps");
  const seed = { ...(await host(root, "seed", { points: ["pending"] })), root };
  // Inventory order is part of the seed. Both records have distinct contents.
  assert.equal(seed.plan.items[1].byteLength, originals[1].length);
  let installed, staged, recordScratch, abortRemoval;
  const journalSeeds = new Map();
  const journalRecoveryCuts = new Map([
    ["admission/after/write/journal-stage/journal-intent.tmp#1", "recover-journal-intent"],
    ["admission/after/write/journal-stage/journal-sealed.tmp#1", "recover-journal-seal"],
    [
      "admission/after/write/journal-stage/journal-publication.tmp#1",
      "recover-journal-publication",
    ],
    ["journal/after/unlink/journal-stage/publication.json#1", "recover-journal-committed"],
  ]);
  async function verify(actual, seed, ticket, published) {
    const { root } = actual;
    await writeFile(path.join(root, "fault"), "off");
    const config = { plan: seed.plan, ticket, sibling: seed.sibling };
    const retry = await host(root, published ? "published" : "retry", config);
    assert.notEqual(retry.epoch, actual.run.cut.epoch);
    const replay = await host(root, "replay", { ...config, ticket: retry.ticket });
    assert.notEqual(replay.epoch, retry.epoch);
    for (const [i, bytes] of originals.entries())
      assert.deepEqual(await readFile(path.join(root, "legacy", "item" + i)), bytes);
  }
  for (const branch of [
    "commit",
    "record-intent",
    "seal-sync",
    "head-write",
    "object-rename",
    "before-publish",
    "recover-record-scratch",
    "recover-abort-removal",
    "recover-installed",
    "recover-staged",
    "recover-duplicate",
    ...journalRecoveryCuts.values(),
  ]) {
    await t.test(branch, { concurrency: 2 }, async (group) => {
      const recovery = branch.startsWith("recover");
      const recordIntent = branch === "record-intent";
      const journalSeed = journalSeeds.get(branch);
      const options = recovery
        ? { recovery: true, recoveryJournalId: journalSeed?.journalId }
        : {
            failure: branch === "commit" || recordIntent ? null : branch,
          };
      let base =
        journalSeed ?? (!recovery ? seed : branch === "recover-staged" ? staged : installed);
      if (branch === "recover-record-scratch") base = recordScratch;
      if (branch === "recover-abort-removal") base = abortRemoval;
      assert.ok(base, "missing interrupted input for " + branch);
      if (branch === "recover-duplicate") {
        // Old copy-before-rename layout with the exact intent, seal and import tag.
        const duplicate = await makeProfile(group);
        await cp(base.root, duplicate, { recursive: true });
        base = { ...base, root: duplicate };
        const dir = path.join(
          base.root,
          "plugins",
          "persistence-v1",
          "namespaces",
          createHash("sha256").update(base.ticket.owner.sourceKey).digest("hex"),
        );
        await cp(
          path.join(
            dir,
            "records",
            base.ticket.target.id,
            "objects",
            base.ticket.metadata.record.revision + ".bin",
          ),
          path.join(dir, "staging", base.ticket.id, "payload.tmp"),
          { errorOnExist: true, force: false },
        );
      }
      const { trace } = await matrixTrial(group, base, options, null);
      const points = trace.map((e) => e.point);
      assert.equal(new Set(points).size, points.length);
      const requirePoint = (name) =>
        assert.ok(points.includes(name + "#1"), name + " missing from " + JSON.stringify(points));
      if (branch.startsWith("recover-journal-")) {
        assert.ok(journalSeed);
        for (const edge of ["before", "after"]) {
          if (branch === "recover-journal-intent") {
            requirePoint("recovery/" + edge + "/unlink/journal-stage/journal-intent.tmp");
            requirePoint("recovery/" + edge + "/removeEmpty/journal-stage");
          } else {
            requirePoint("recovery/" + edge + "/atomicReplace/journal-stage/resolved.json");
            requirePoint("recovery/" + edge + "/syncDirectory/journal-stage");
            if (branch !== "recover-journal-committed") {
              const doc = branch === "recover-journal-seal" ? "sealed" : "publication";
              requirePoint("recovery/" + edge + "/unlink/journal-stage/journal-" + doc + ".tmp");
            }
          }
        }
      } else if (branch === "recover-record-scratch" || branch === "recover-abort-removal") {
        const steps =
          branch === "recover-record-scratch"
            ? ["unlink/stage/import-record-intent.tmp", "removeEmpty/stage"]
            : [
                "unlink/quarantine/object",
                "syncDirectory/quarantine#2",
                "unlink/quarantine/candidate",
                "syncDirectory/quarantine#3",
              ];
        let previous = -1;
        for (const step of steps)
          for (const edge of ["before", "after"]) {
            const index = points.indexOf(
              "recovery/" + edge + "/" + step + (step.includes("#") ? "" : "#1"),
            );
            assert.ok(index > previous, edge + "/" + step + " in " + points.join(","));
            previous = index;
          }
      } else if (recovery) {
        for (const name of [
          "recovery/before/removeEmpty/stage",
          "recovery/after/unlink/stage/intent.json",
        ])
          requirePoint(name);
        if (branch === "recover-staged") requirePoint("recovery/after/unlink/record/candidate");
        else
          for (const step of [
            "atomicReplace/quarantine/object",
            "syncDirectory/quarantine",
            "syncDirectory/record/objects",
            "atomicReplace/quarantine/candidate",
            "syncDirectory/record",
          ])
            requirePoint("recovery/after/" + step);
      } else if (recordIntent || branch === "commit") {
        for (const edge of ["before", "after"]) {
          for (const op of ["openOwned", "write", "sync", "closeOwned"])
            requirePoint("reserve/" + edge + "/" + op + "/stage/import-record-intent.tmp");
          assert.ok(points.includes("reserve/" + edge + "/write/stage/import-record-intent.tmp#2"));
          requirePoint("reserve/" + edge + "/atomicReplace/stage/intent.json");
          requirePoint("reserve/" + edge + "/syncDirectory/stage");
        }
        requireInstallSync(points, "reserve/", "stage", ["intent"]);
      }
      if (branch === "commit") {
        for (const name of [
          "admission/after/import-marker",
          "reserve/after/reserve",
          "tagImport/after/write/stage/import-tag.json",
          "append/after/write/stage/payload.tmp",
          "seal/after/seal-sync",
          "publishOne/before/atomicReplace/record/head.json",
          "publishOne/after/dispatch",
          "publishOne/after/cas",
          "publishOne/after/quota-commit",
          "publishOne/after/receipt-send",
          "journal/after/import-marker",
          "completion/after/import-marker",
        ])
          requirePoint(name);
        assert.ok(points.includes("append/after/write/stage/payload.tmp#2"));
        for (const phase of ["admission", "journal", "completion"])
          requireInstallSync(points, phase + "/", "journal-stage");
        for (const phase of ["admission", "journal", "completion"])
          for (const edge of ["before", "after"]) {
            for (const op of [
              "import-marker",
              "atomicReplace/journal/head",
              "syncDirectory/imports",
              ...["intent", "sealed", "publication"].flatMap((name) => [
                ...["openOwned", "write", "sync", "closeOwned"].map(
                  (op) => op + "/journal-stage/journal-" + name + ".tmp",
                ),
                "atomicReplace/journal-stage/" + name + ".json",
              ]),
              "syncDirectory/journal-stage",
              "unlink/journal-stage/publication.json",
              "unlink/journal-stage/intent.json",
            ])
              requirePoint([phase, edge, op].join("/"));
            for (const doc of ["intent", "sealed", "publication"])
              assert.ok(
                points.includes(
                  [phase, edge, "write/journal-stage/journal-" + doc + ".tmp#2"].join("/"),
                ),
              );
          }
      } else if (!recovery && !recordIntent) {
        if (branch === "before-publish") {
          assertAbortOrder(points);
        }
        requirePoint("removeUnpublished/after/removeEmpty/stage");
        requirePoint(
          "removeUnpublished/after/quota-" + (branch === "before-publish" ? "commit" : "release"),
        );
      }
      // Common successful preparation is cut once, on commit. Every abort-specific
      // effect is cut separately for each fault, including repeated directory syncs.
      const selected = points.filter(
        (p) =>
          recovery ||
          branch === "commit" ||
          p.startsWith("removeUnpublished/") ||
          (recordIntent &&
            p.startsWith("reserve/") &&
            (p.includes("import-record-intent.tmp") ||
              p.includes("/atomicReplace/stage/intent.json") ||
              p.includes("/syncDirectory/stage#"))),
      );
      group.diagnostic(branch + " " + selected.length + " before/after placements");
      await Promise.all(
        selected.map((cut) =>
          group.test(cut, async (c) => {
            const actual = await matrixTrial(c, base, options, cut);
            const index = points.indexOf(cut);
            assert.deepEqual(
              actual.trace.map((e) => e.point),
              points.slice(0, index + 1),
            );
            const ticket = actual.run.cut.ticket;
            assert.ok(actual.trace.every((e) => e.ticket === ticket.id));
            if (
              !recovery &&
              branch === "commit" &&
              ["publishOne/before/object-rename#1", "publishOne/before/before-publish#1"].includes(
                cut,
              )
            ) {
              const copy = await makeProfile(t);
              await cp(actual.root, copy, { recursive: true });
              const snapshot = { ...seed, root: copy, ticket };
              if (cut.includes("object-rename")) staged = snapshot;
              else installed = snapshot;
            }
            if (
              (branch === "commit" &&
                cut === "reserve/after/write/stage/import-record-intent.tmp#1") ||
              (branch === "before-publish" &&
                cut === "removeUnpublished/before/unlink/quarantine/object#1")
            ) {
              const copy = await makeProfile(t);
              await cp(actual.root, copy, { recursive: true });
              if (branch === "commit") recordScratch = { ...seed, root: copy, ticket };
              else abortRemoval = { ...seed, root: copy, ticket };
            }
            const stopped = actual.run.cut.event;
            const doc = /^journal-stage\/journal-(intent|sealed|publication)\.tmp$/.exec(
              stopped.file,
            );
            if (
              (branch === "commit" || recordIntent) &&
              cut === "reserve/after/write/" + stopped.file + "#1" &&
              ["stage/import-record-intent.tmp", "stage/intent.json"].includes(stopped.file)
            ) {
              await assert.rejects(
                readFile(path.join(path.dirname(stopped.diskPath), "intent.json")),
                { code: "ENOENT" },
              );
              const partial = await readFile(stopped.diskPath, "utf8");
              assert.ok(partial.length > 0);
              assert.throws(() => JSON.parse(partial), SyntaxError);
            }
            if (branch === "commit" && doc) {
              const finalName = path.join(path.dirname(stopped.diskPath), doc[1] + ".json");
              await assert.rejects(readFile(finalName), { code: "ENOENT" });
              if (cut.includes("/after/write/") && cut.endsWith("#1")) {
                const partial = await readFile(stopped.diskPath, "utf8");
                assert.ok(partial.length > 0);
                assert.throws(() => JSON.parse(partial), SyntaxError);
              }
            }
            if (branch === "commit" && cut.includes("/after/atomicReplace/journal-stage/")) {
              const final = JSON.parse(await readFile(stopped.diskPath, "utf8"));
              assert.equal(final.formatVersion, 1);
              const id = path.basename(path.dirname(stopped.diskPath));
              if (stopped.file.endsWith("/intent.json")) assert.equal(final.ticket.id, id);
              if (stopped.file.endsWith("/publication.json"))
                assert.equal(final.receipt.commitId, id);
            }
            const recoveryBranch = journalRecoveryCuts.get(cut);
            if (branch === "commit" && recoveryBranch) {
              const copy = await makeProfile(t);
              await cp(actual.root, copy, { recursive: true });
              journalSeeds.set(recoveryBranch, {
                ...seed,
                root: copy,
                journalId: path.basename(path.dirname(stopped.diskPath)),
                ticket: recoveryBranch === "recover-journal-committed" ? ticket : seed.ticket,
              });
            }
            const beforeAdmission =
              !recovery && index < points.indexOf("admission/after/atomicReplace/journal/head#1");
            const published =
              branch === "recover-journal-committed" ||
              (branch === "commit" &&
                index >= points.indexOf("publishOne/after/atomicReplace/record/head.json#1"));
            await verify(actual, base, beforeAdmission ? seed.ticket : ticket, published);
            if (
              branch === "recover-abort-removal" ||
              (branch === "before-publish" &&
                index >=
                  points.indexOf("removeUnpublished/after/atomicReplace/stage/abort-tag.json#1"))
            ) {
              const quarantine = path.join(
                actual.root,
                "plugins",
                "persistence-v1",
                "namespaces",
                createHash("sha256").update(ticket.owner.sourceKey).digest("hex"),
                "quarantine",
              );
              assert.deepEqual(await readdir(quarantine), []);
            }
          }),
        ),
      );
    });
  }
  await t.test("a second interrupted writer uses the same planned target", async (c) => {
    assert.ok(installed);
    const actual = await matrixTrial(
      c,
      installed,
      { failure: null },
      "publishOne/before/before-publish#1",
    );
    const second = actual.run.cut.ticket;
    assert.notEqual(second.id, installed.ticket.id);
    assert.deepEqual(second.target, installed.ticket.target);
    await verify(actual, installed, second, false);
    const ns = path.join(
      actual.root,
      "plugins",
      "persistence-v1",
      "namespaces",
      createHash("sha256").update(second.owner.sourceKey).digest("hex"),
    );
    for (const attempt of [installed.ticket, second]) {
      const retained = path.join(ns, "quarantine", attempt.id + ".prepublish");
      assert.deepEqual(await readFile(retained + ".bin"), originals[1]);
      assert.equal(JSON.parse(await readFile(retained + "-head")).receipt.commitId, attempt.id);
    }
  });
});

async function verifyPlanCut(t, branch, cut, points) {
  const root = await makeProfile(t);
  const stopped = await host(root, "plan-write", { branch, cut });
  const trace = (await readFile(path.join(root, "cut-trace"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  if (points)
    assert.deepEqual(
      trace.map((e) => e.point),
      points.slice(0, points.indexOf(cut) + 1),
    );
  const { ticket } = stopped;
  const ns = path.join(
    root,
    "plugins",
    "persistence-v1",
    "namespaces",
    createHash("sha256").update(ticket.owner.sourceKey).digest("hex"),
  );
  const exists = async (p) => {
    try {
      await readFile(p);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  };
  const installed = await exists(path.join(ns, "staging", ticket.id, "intent.json"));
  const published =
    branch === "initial-plan" &&
    trace.some((e) => e.point === "after/atomicReplace/imports/head#1");
  const expected = published || branch === "abort-update" ? "pending" : "absent";
  const config = {
    branch,
    expected,
    ticket,
    disposition: installed ? (published ? "committed" : "not-committed") : "unknown",
  };
  const first = await host(root, "plan-restart", config);
  const second = await host(root, "plan-restart", { ...config, retry: true });
  assert.notEqual(first.epoch, second.epoch);
  await host(root, "plan-restart", { branch, expected: "complete" });
}

for (const branch of ["abort-initial", "abort-update"]) {
  test("private journal object unlink restart " + branch, (t) =>
    verifyPlanCut(t, branch, "after/unlink/imports/object#1"),
  );
}

function requireInstallSync(points, prefix, dir, documents = ["intent", "sealed", "publication"]) {
  for (const doc of documents) {
    const label = prefix + "after/atomicReplace/" + dir + "/" + doc + ".json#";
    assert.ok(points.includes(label + "1"), "missing rename " + label);
    for (const [index, point] of points.entries()) {
      if (!point.startsWith(label)) continue;
      const start = points[index + 1];
      assert.match(start, new RegExp("^" + prefix + "before/syncDirectory/" + dir + "#\\d+$"));
      const finish = points.indexOf(
        start.replace("before/syncDirectory", "after/syncDirectory"),
        index + 2,
      );
      assert.ok(finish > index + 1, "missing directory sync completion following " + point);
      assert.ok(
        !points
          .slice(index + 2, finish)
          .some((p) => p.startsWith(prefix + "before/atomicReplace/" + dir + "/")),
        "next rename preceded sync completion for " + point,
      );
    }
  }
}

for (const branch of ["abort-initial", "abort-update", "initial-plan"]) {
  test("private journal placements " + branch, { concurrency: 2 }, async (t) => {
    const root = await makeProfile(t);
    await host(root, "plan-write", { branch });
    const points = (await readFile(path.join(root, "cut-trace"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).point);
    if (branch === "initial-plan") requireInstallSync(points, "", "stage");
    else {
      const witness = points.indexOf("after/unlink/stage/publication.json#1");
      const sync = points.indexOf("after/syncDirectory/stage#1");
      const object = points.indexOf("before/unlink/imports/object#1");
      assert.ok(witness >= 0 && witness < sync && sync < object);
    }
    t.diagnostic(branch + " " + points.length + " before/after placements");
    await Promise.all(
      points.map((cut) => t.test(cut, (c) => verifyPlanCut(c, branch, cut, points))),
    );
  });
}

for (const shape of ["missing object", "invalid seal prefix", "invalid publication prefix"]) {
  test("preserves ambiguous private journal evidence with " + shape, async (t) => {
    const root = await makeProfile(t);
    const missing = shape === "missing object";
    const cut = missing
      ? "before/unlink/stage/publication.json#1"
      : "after/write/stage/journal-" +
        (shape === "invalid seal prefix" ? "sealed" : "publication") +
        ".tmp#1";
    const { ticket } = await host(root, "plan-write", {
      branch: missing ? "abort-initial" : "initial-plan",
      cut,
    });
    const trace = (await readFile(path.join(root, "cut-trace"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const { path: file } = trace.at(-1);
    const bytes = await readFile(file);
    if (missing) {
      const ns = path.dirname(path.dirname(path.dirname(file)));
      await rm(path.join(ns, "imports", "objects", JSON.parse(bytes).object));
    } else {
      // Keep the byte count and all siblings of a real interrupted installation.
      bytes[bytes.length - 1] = 0xff;
      await writeFile(file, bytes);
    }
    let last = ticket.owner.hostEpoch;
    for (let i = 0; i < 2; i++) {
      const boot = await host(root, "plan-blocked", { ticket });
      assert.notEqual(boot.epoch, last);
      last = boot.epoch;
      assert.deepEqual(await readFile(file), bytes);
      await assert.rejects(readFile(path.join(path.dirname(file), "resolved.json")), {
        code: "ENOENT",
      });
    }
  });
}
