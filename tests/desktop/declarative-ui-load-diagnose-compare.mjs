// Orchestrator only. Pause each original three-trial driver at the trial
// boundary. Preparation and Electron runs are serialized on one desktop.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const driver = "tests/desktop/declarative-ui-motion-run.mjs";
const self = fileURLToPath(import.meta.url);
const boundary = "for (const scenario of selected) {";

if (process.env.KOBRIXA_COMPARE_CHILD === "1") {
  globalThis.waitForLoadTrial = async (repeat) => {
    const permission = once(process, "message");
    process.send({ repeat });
    const [message] = await permission;
    assert.equal(message.repeat, repeat);
    if (repeat === 2) process.disconnect();
  };
  registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (url !== pathToFileURL(path.resolve(driver)).href) return result;
      const source = Buffer.from(result.source).toString();
      assert.equal(source.split(boundary).length, 2);
      return {
        ...result,
        source: source.replace(
          boundary,
          boundary + "\nawait globalThis.waitForLoadTrial(scenario.repeat);",
        ),
      };
    },
  });
} else if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [outArg, ...trees] = process.argv.slice(2);
  assert.equal(trees.length, 3, "Pass a NEW output directory and baseline, HEAD, candidate trees");
  const out = path.resolve(outArg);
  await mkdir(out);
  const workers = [];
  const results = [];
  try {
    for (const [i, tree] of trees.entries()) {
      const cwd = path.resolve(tree);
      const dir = path.join(out, ["baseline", "head", "candidate"][i]);
      await mkdir(dir);
      const fd = openSync(path.join(dir, "driver.log"), "wx");
      const imports = ["--import", pathToFileURL(self).href];
      // The historical driver predates the Windows journal addon.
      if (i !== 0) imports.push("--import", "./tools/release/journal-harness.mjs");
      const child = fork(path.resolve(cwd, driver), ["--load"], {
        cwd,
        execArgv: imports,
        stdio: ["ignore", fd, fd, "ipc"],
        env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir, KOBRIXA_COMPARE_CHILD: "1" },
      });
      closeSync(fd);
      const worker = { child, pending: null, exit: null, cwd, dir };
      const ended = new Promise((resolve) =>
        child.once("exit", (code, signal) => {
          worker.exit = { code, signal };
          resolve({ exit: worker.exit });
        }),
      );
      worker.next = () => Promise.race([ended, once(child, "message").then(([value]) => value)]);
      workers.push(worker);
      worker.pending = await worker.next();
    }
    for (const [repeat, order] of [
      [0, [0, 1, 2]],
      [1, [1, 2, 0]],
      [2, [2, 0, 1]],
    ]) {
      for (const i of order) {
        const worker = workers[i];
        if (!worker.exit) {
          assert.equal(worker.pending.repeat, repeat);
          const next = worker.next();
          worker.child.send({ repeat });
          worker.pending = await next;
          results.push({ tree: worker.cwd, repeat, next: worker.pending });
        } else results.push({ tree: worker.cwd, repeat, status: "NOT RUN", exit: worker.exit });
        await writeFile(path.join(out, "schedule.json"), JSON.stringify(results, null, 2));
      }
    }
    if (workers.some((w) => w.exit?.code !== 0)) process.exitCode = 1;
  } finally {
    for (const worker of workers) if (!worker.exit) worker.child.kill();
  }
}
