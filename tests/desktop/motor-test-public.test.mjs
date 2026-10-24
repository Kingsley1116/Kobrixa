import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  compose,
  buildNative,
  until,
  lifecycleMatrix,
  validateNative,
  nativeCases,
  selectNativeCases,
  caseName,
} from "./motor-test-public-run.mjs";

const requests = (c, name) =>
  c.wire.filter(
    (r) => r.direction === "plugin-host" && r.message.method === `devices/motion/${name}`,
  );
async function fixture(work) {
  const c = await compose();
  try {
    await until(
      () => c.states.state(c.owner, c.panel.binding).value?.data.available,
      "selection ready",
    );
    await work(c);
  } finally {
    await c.dispose();
  }
}
const form = (c, mode) => ({ ...c.panel.form, "a-mode": mode });
async function selected(c) {
  assert.equal((await c.invoke("select-current")).ok, true);
}
async function terminal(c) {
  const id = await until(() => requests(c, "start")[0]?.message.params.operationId, "start ID");
  return until(async () => {
    const r = await c.broker.request(
      c.principal,
      "devices/motion/query",
      { operationId: id },
      new AbortController().signal,
    );
    return (
      r.ok &&
      ["completed", "stopped", "failed", "unconfirmed", "timeout"].includes(
        r.value.operation.phase,
      ) &&
      r.value.operation
    );
  }, "terminal broker snapshot");
}

test("actual motor entry is cold; explicit selection precedes motion", { timeout: 15000 }, () =>
  fixture(async (c) => {
    assert.equal(requests(c, "prepare").length, 0);
    assert.equal(
      c.wire.filter((r) => r.direction === "plugin-host" && r.message.method === "devices/connect")
        .length,
      0,
    );
    await c.invoke("start", form(c, "timed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests(c, "prepare").length, 0);
    await selected(c);
    await c.invoke("start", form(c, "timed"));
    const result = await terminal(c);
    assert.equal(result.stopConfirmation, "confirmed");
    assert.equal(requests(c, "prepare").length, 1);
    assert.equal(requests(c, "start").length, 1);
  }),
);
for (const mode of ["jog", "timed", "relative-angle"])
  test(`actual SDK + broker completes ${mode} with one original ID`, { timeout: 15000 }, () =>
    fixture(async (c) => {
      await selected(c);
      await c.invoke(
        mode === "jog" ? "jog" : "start",
        form(c, mode),
        mode === "jog" ? "begin" : undefined,
      );
      const result = await terminal(c);
      assert.equal(requests(c, "prepare").length, 1);
      assert.equal(requests(c, "start").length, 1);
      assert.equal(requests(c, "prepare")[0].message.params.motion.mode, mode);
      assert.equal(requests(c, "start")[0].message.params.operationId, result.operationId);
      assert.equal(result.stopConfirmation, "confirmed");
      assert.ok(c.fake.control.trace().some((r) => r.dispatch === "sent"));
    }),
  );
for (const rejection of ["read-only", "recording/program"])
  test(`broker rejects ${rejection} ownership`, { timeout: 15000 }, () =>
    fixture(async (c) => {
      await selected(c);
      if (rejection === "read-only") c.setWritable(false);
      else c.setBusy(true);
      await c.invoke("start", form(c, "timed"));
      if (rejection === "read-only") {
        await until(
          () =>
            c.wire.some(
              (r) =>
                r.direction === "host-plugin" &&
                r.message.result?.value?.state === "restricted" &&
                r.message.result.value.reason === "viewer",
            ),
          "actual SDK viewer context",
        );
        assert.equal(requests(c, "prepare").length, 0);
        assert.equal(requests(c, "start").length, 0);
        assert.equal(c.fake.control.trace().filter((r) => r.step === "motion-pulse").length, 0);
        return;
      }
      await until(() => requests(c, "prepare").length, "admission attempted");
      await until(
        () =>
          c.wire.some(
            (r) =>
              r.direction === "host-plugin" &&
              r.message.id === requests(c, "prepare")[0].message.id &&
              r.message.result?.ok === false &&
              r.message.result.error?.code ===
                (rejection === "read-only" ? "PLUGIN_E_DEVICE_AUTHORITY" : "PLUGIN_E_DEVICE_BUSY"),
          ),
        "public admission rejection",
      );
      assert.equal(requests(c, "start").length, 0);
      assert.equal(c.fake.control.trace().filter((r) => r.step === "motion-pulse").length, 0);
    }),
  );
for (const boundary of ["prepare", "start"])
  test(
    `hide while ${boundary} reply pending: late reply cannot revive motion`,
    { timeout: 15000 },
    () =>
      fixture(async (c) => {
        await selected(c);
        c.hold(boundary);
        if (boundary === "start") c.fake.control.block("before-exchange", "motion-pulse");
        await c.invoke("start", form(c, "timed"));
        await until(c.held, "held original reply");
        c.hide();
        if (boundary === "start") c.fake.control.release("before-exchange", "motion-pulse");
        c.release();
        await until(() => requests(c, "stop").length, "original ID stop");
        const stop = requests(c, "stop")[0].message.params.operationId;
        assert.equal(requests(c, "prepare").length, 1);
        assert.ok(requests(c, "start").length <= (boundary === "prepare" ? 0 : 1));
        const receipt = await until(
          () =>
            c.wire.find(
              (r) =>
                r.direction === "host-plugin" &&
                r.message.id === requests(c, "stop")[0].message.id &&
                r.message.result?.ok,
            )?.message.result.value.operation,
          "original stop receipt",
        );
        assert.equal(receipt.operationId, stop);
        assert.ok(
          receipt.stopConfirmation === "confirmed" ||
            (receipt.stopConfirmation === "not-required" && receipt.dispatch === "not-sent"),
        );
        assert.equal(
          c.fake.control.trace().filter((r) => r.step === "motion-pulse" && r.dispatch === "sent")
            .length,
          0,
        );
      }),
  );
test("lost start reply queries original ID without retry", { timeout: 15000 }, () =>
  fixture(async (c) => {
    await selected(c);
    c.hold("start", true);
    await c.invoke("start", form(c, "timed"));
    await until(c.held, "lost start reply");
    const lostAt = performance.now();
    c.release();
    const id = requests(c, "start")[0].message.params.operationId;
    await until(
      () =>
        requests(c, "query").some(
          (r) => r.at >= lostAt + 4500 && r.message.params.operationId === id,
        ),
      "query same ID after lost-start timeout",
      6500,
    );
    assert.equal(requests(c, "prepare").length, 1);
    assert.equal(requests(c, "start").length, 1);
  }),
);
test("invalid form rejects start; source loss never reconnects", { timeout: 15000 }, () =>
  fixture(async (c) => {
    await selected(c);
    const invalid = await c.invoke("start", { ...form(c, "timed"), "a-power": null });
    assert.ok(invalid.ok && invalid.value.fieldErrors.length);
    assert.equal(requests(c, "prepare").length, 0);
    c.fake.provider.lose();
    await until(
      () =>
        c.wire.some(
          (r) =>
            r.message.method === "events/deliver" &&
            JSON.stringify(r.message).includes("devices.catalog"),
        ),
      "source loss event",
    );
    await c.invoke("start", form(c, "timed"));
    assert.equal(requests(c, "start").length, 0);
    assert.equal(
      c.wire.filter((r) => r.direction === "plugin-host" && r.message.method === "devices/connect")
        .length,
      0,
    );
  }),
);
test("native matrix is complete as a case inventory; absent/fabricated evidence fails", () => {
  assert.equal(lifecycleMatrix.length, 56);
  for (const scenario of lifecycleMatrix) {
    assert.throws(() => validateNative({}, {}, scenario));
    assert.throws(() =>
      validateNative(
        {
          kind: "motor-public-native",
          artifact: {},
          scenario,
          composition: "composeDesktopMain/createDesktopFoundation",
          stdout: "",
          wire: [],
          native: [],
          trace: [],
          pass: true,
        },
        {},
        scenario,
      ),
    );
  }
});

// This assertion remains red on fb69d35; do not rewrite delivery to bypass the router.
test(
  "generic UI notifications remain valid through the actual public router",
  { timeout: 15000 },
  () =>
    fixture(async (c) => {
      await until(() => c.wire.some((r) => r.message.method === "ui/patch"), "actual patch");
      assert.deepEqual(
        c.routeErrors,
        [],
        "B1 UI notification delivery/schema integration required",
      );
    }),
);

for (const boundary of ["prepare", "start"])
  test(`jog cancel while ${boundary} reply pending preserves original ID`, { timeout: 15000 }, () =>
    fixture(async (c) => {
      await selected(c);
      c.hold(boundary);
      if (boundary === "start") c.fake.control.block("before-exchange", "motion-pulse");
      await c.invoke("jog", form(c, "jog"), "begin");
      await until(c.held, "pending SDK reply");
      await c.invoke("jog", form(c, "jog"), "cancel");
      if (boundary === "start") c.fake.control.release("before-exchange", "motion-pulse");
      c.release();
      await until(() => requests(c, "stop").length, "cancel original operation");
      assert.equal(requests(c, "prepare").length, 1);
      assert.equal(requests(c, "start").length, boundary === "prepare" ? 0 : 1);
      const prepare = requests(c, "prepare")[0];
      const reply = c.wire.find(
        (r) => r.direction === "host-plugin" && r.message.id === prepare.message.id,
      );
      assert.ok(reply?.message.result?.value?.operation?.operationId);
      assert.ok(
        requests(c, "stop").every(
          (r) => r.message.params.operationId === reply.message.result.value.operation.operationId,
        ),
      );
    }),
  );
test("duplicate begin during pending prepare cannot prepare twice", { timeout: 15000 }, () =>
  fixture(async (c) => {
    await selected(c);
    c.hold("prepare");
    await c.invoke("start", form(c, "timed"));
    await until(c.held, "pending prepare");
    await c.invoke("start", form(c, "timed"));
    assert.equal(requests(c, "prepare").length, 1);
    c.release();
    await terminal(c);
    assert.equal(requests(c, "prepare").length, 1);
    assert.equal(requests(c, "start").length, 1);
  }),
);

test("host core Stop bypasses invalid form during pending prepare", { timeout: 15000 }, () =>
  fixture(async (c) => {
    await selected(c);
    c.hold("prepare");
    await c.invoke("start", form(c, "timed"));
    await until(c.held, "prepared original operation");
    const prepare = requests(c, "prepare")[0];
    // Generic host state only: this is not a native input/validation receipt.
    const invalid = { ...c.panel.form, "a-power": null };
    assert.ok(c.states.setForm(c.owner, c.panel.binding, 1, invalid, false).ok);
    const stopped = await c.coreStop(prepare.message.params.sessionId);
    assert.equal(stopped.ok, true);
    assert.ok(c.fake.control.trace().some((r) => r.step === "stop" && r.dispatch === "sent"));
    assert.ok(c.fake.control.trace().some((r) => r.step === "readback" && r.dispatch === "sent"));
    c.release();
  }),
);

test("native CLI selects every authored case exactly once and rejects unknown cases", () => {
  assert.equal(lifecycleMatrix.length, 56);
  assert.equal(nativeCases.length, 77);
  assert.deepEqual(selectNativeCases(["--all"]), nativeCases);
  assert.equal(new Set(nativeCases.map(caseName)).size, nativeCases.length);
  for (const scenario of nativeCases)
    assert.deepEqual(selectNativeCases([`--case=${caseName(scenario)}`]), [scenario]);
  for (const args of [
    [],
    ["--all", "extra"],
    ["--case=unknown"],
    ["--case=pulse:after:hide:omitted"],
  ])
    assert.throws(() => selectNativeCases(args));
  for (const mode of ["jog", "timed", "relative-angle"])
    assert.ok(nativeCases.some((s) => s.mode === mode));
  for (const key of ["Space", "Enter"]) assert.ok(nativeCases.some((s) => s.key === key));
  for (const parity of ["drafts", "layout", "invalid-stop"])
    assert.ok(nativeCases.some((s) => s.parity === parity));
  for (const fault of [
    "motor-disable",
    "provider-disable",
    "suspend",
    "disconnect",
    "second-launch",
  ])
    assert.ok(nativeCases.some((s) => s.fault === fault));
  assert.ok(nativeCases.some((s) => s.safeMode));
});

// Node worker execution checks the actual emitted artifact without launching Electron.
test(
  "integrated native motor artifact boots and closes its production persistence worker",
  { timeout: 15000 },
  async (t) => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "motor-worker-build-")));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const { identity } = await buildNative(directory);
    assert.match(identity.nativeBuildSha256["persistence-worker.cjs"], /^[a-f0-9]{64}$/);
    const root = path.join(directory, "store");
    await mkdir(path.join(root, "namespaces"), { recursive: true, mode: 0o700 });
    const held = new SharedArrayBuffer(16 + 1024 * 16 + 1024 * 4);
    Atomics.store(new Int32Array(held), 0, 1);
    const worker = new Worker(path.join(directory, "persistence-worker.cjs"), { workerData: {} });
    t.after(async () => {
      await worker.terminate();
      Atomics.store(new Int32Array(held), 0, 0);
    });
    await new Promise((resolve, reject) => {
      let ready = false;
      worker.once("error", reject);
      worker.once("message", (message) => {
        try {
          assert.equal(message.version, 1);
          assert.equal(message.kind, "ready");
          assert.equal(message.recovery, "ready");
          ready = true;
          worker.postMessage({ version: 1, kind: "close" });
        } catch (error) {
          reject(error);
        }
      });
      worker.once("exit", (code) => {
        try {
          assert.equal(code, 0);
          assert.equal(ready, true);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      worker.postMessage({
        version: 1,
        kind: "boot",
        hostEpoch: "10000000-0000-4000-8000-000000000001",
        root,
        held,
      });
    });
  },
);
