import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, cp, lstat, readlink, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import {
  closePackagedBrowser,
  collectQuitEvidence,
  runPackagedSmoke,
  waitForQuit,
} from "./packaged-smoke.mjs";
import { test } from "node:test";

async function failedCopy() {
  let options, profile;
  const cleanups = [];
  await assert.rejects(
    runPackagedSmoke({
      copy: async (_source, destination, input) => {
        profile = path.dirname(destination);
        options = input;
        throw new Error("copy failed");
      },
      cleanup: async (...args) => {
        cleanups.push(args);
        await rm(...args);
      },
    }),
    /copy failed/,
  );
  return { options, profile, cleanups };
}

test("packaged copy failure cleans up the isolated profile", async () => {
  const { profile, cleanups } = await failedCopy();
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0][0], profile);
  await assert.rejects(lstat(profile), { code: "ENOENT" });
  assert.equal(cleanups[0][1].recursive, true);
  assert.equal(cleanups[0][1].force, true);
});

test("packaged copy preserves app framework symlinks verbatim", async () => {
  const { options } = await failedCopy();
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-bundle-links-"));
  try {
    const source = path.join(root, "source");
    const installed = path.join(root, "installed");
    await mkdir(path.join(source, "Versions/A"), { recursive: true });
    await writeFile(path.join(source, "Versions/A/Framework"), "fixture");
    await symlink("A", path.join(source, "Versions/Current"), "dir");
    await symlink("Versions/Current/Framework", path.join(source, "Framework"), "file");
    await cp(source, installed, options);
    for (const [name, target] of [
      ["Versions/Current", "A"],
      ["Framework", "Versions/Current/Framework"],
    ]) {
      assert.equal((await lstat(path.join(installed, name))).isSymbolicLink(), true);
      // Windows reports relative link targets with backslashes.
      assert.equal((await readlink(path.join(installed, name))).split(path.sep).join("/"), target);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed Browser.close send fails even with an independent clean exit", async () => {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  const sendError = new Error("socket send failed");
  socket.send = (data) => {
    assert.equal(JSON.parse(data).method, "Browser.close");
    throw sendError;
  };
  socket.close = () => {};
  const exit = Promise.withResolvers();
  const quit = closePackagedBrowser(
    socket,
    exit.promise,
    () => assert.fail("Unexpected timeout"),
    {},
  );
  socket.dispatchEvent(new Event("open"));
  exit.resolve({ code: 0, signal: null });
  await assert.rejects(quit, (error) => error === sendError);
});

test("a sent Browser.close can lose its acknowledgement before clean exit", async () => {
  const socket = new EventTarget();
  socket.readyState = WebSocket.OPEN;
  const exit = Promise.withResolvers();
  socket.send = () => {
    socket.dispatchEvent(new Event("close"));
    exit.resolve({ code: 0, signal: null });
  };
  socket.close = () => {};
  const lifecycle = {};
  const quit = closePackagedBrowser(
    socket,
    exit.promise,
    () => assert.fail("Unexpected timeout"),
    lifecycle,
  );
  socket.dispatchEvent(new Event("open"));
  await quit;
  assert.equal(lifecycle.browserClose, "sent");
  assert.equal(lifecycle.browserTransport, "closed");
});

test("packaged quit timeout retains evidence even if the app exits during collection", async () => {
  const exit = Promise.withResolvers();
  const evidence = {
    lifecycle: { phase: "restored dirty draft" },
    recovery: { unavailable: "closed" },
    processes: [{ pid: 123 }],
  };
  await assert.rejects(
    waitForQuit(
      exit.promise,
      () => {
        exit.resolve({ code: 0, signal: null });
        return evidence;
      },
      async (ms, expired) => {
        assert.equal(ms, 5000);
        return expired;
      },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Application did not quit within 5000 ms: ${JSON.stringify(evidence)}`,
      );
      return true;
    },
  );
});

test("packaged quit requires a clean natural exit", async () => {
  const unused = () => assert.fail("Unexpected timeout investigation");
  await waitForQuit(Promise.resolve({ code: 0, signal: null }), unused);
  await assert.rejects(
    waitForQuit(Promise.resolve({ code: 1, signal: null }), unused),
    /Unexpected packaged application exit/,
  );
});

test("a lost renderer preserves independent quit diagnostics", async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "kobrixa-smoke-quit-"));
  try {
    await mkdir(path.join(profile, "device-broker"));
    await writeFile(path.join(profile, "device-broker/faults.json"), "{}");
    const rows = [
      { pid: 31, ppid: 1 },
      { pid: 32, ppid: 31 },
      { pid: 33, ppid: 1 },
    ];
    const evidence = await collectQuitEvidence(
      () => {
        throw Error("Renderer gone");
      },
      profile,
      31,
      async () => rows,
    );
    assert.deepEqual(evidence.processes, rows.slice(0, 2));
    assert.deepEqual(evidence.recovery, { unavailable: "Error: Renderer gone" });
    assert.deepEqual(evidence.journalEntries, ["faults.json"]);
    assert.match(evidence.sessionMarker.unavailable, /ENOENT/);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("quit diagnostics retain recovery blockers across pages and session save failures", async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "kobrixa-smoke-recovery-"));
  try {
    const item = { kind: "device", state: "unconfirmed" };
    const context = {
      document: {
        querySelectorAll: () => [],
        querySelector: () => ({ textContent: "Could not save the session" }),
      },
      window: {
        kobrixa: {
          plugins: {
            state: async () => ({
              safeMode: false,
              plugins: [{ sourceKey: "test", running: true }],
            }),
            recovery: {
              snapshot: async ({ cursor }) => ({
                ok: true,
                value: cursor
                  ? { items: [item], nextCursor: null }
                  : { items: [], nextCursor: "next" },
              }),
            },
          },
        },
      },
    };
    const evidence = await collectQuitEvidence(
      (expression) => vm.runInNewContext(expression, context),
      profile,
      31,
      async () => [],
    );
    assert.equal(evidence.recovery.length, 2);
    assert.deepEqual(evidence.recovery[1].value.items, [item]);
    assert.equal(evidence.plugins.plugins[0].running, true);
    assert.equal(evidence.workbench.sessionIssues, "Could not save the session");
    assert.match(evidence.processes.unavailable, /Parent absent/);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
