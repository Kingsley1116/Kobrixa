import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const filename = fileURLToPath(import.meta.url);
const addonPath = path.resolve(
  process.env.KOBRIXA_JOURNAL_WIN32_ADDON ??
    fileURLToPath(
      new URL(
        "../../apps/desktop/native/journal-win32/build/Release/journal_win32.node",
        import.meta.url,
      ),
    ),
);
// On Windows an absent, wrong-ABI or unloadable addon is a hard test failure.
const production = process.platform === "win32" ? require(addonPath) : undefined;
// Build the same source separately with --journal_test_hooks=1 for historical
// candidate/kill frontiers. Never ship that binary or enable callbacks via env.
const testAddonPath = process.env.KOBRIXA_JOURNAL_WIN32_TEST_ADDON;
const native = process.platform === "win32" ? require(testAddonPath ?? addonPath) : undefined;
const notRun = process.platform === "win32" ? false : "NOT RUN: requires real Windows Win32 I/O";

function snapshot(revision, state) {
  // Opaque filesystem fixtures, not a substitute for journal.ts schema/recovery tests.
  const body = JSON.stringify({ revision, state });
  return Buffer.from(
    JSON.stringify({ body, digest: createHash("sha256").update(body).digest("hex") }),
  );
}
const oldBytes = snapshot(1, "pending");
const newBytes = snapshot(2, "resolved");
function readSnapshot(file) {
  const bytes = readFileSync(file);
  const value = JSON.parse(bytes);
  assert.equal(createHash("sha256").update(value.body).digest("hex"), value.digest);
  return { bytes, ...JSON.parse(value.body) };
}
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kobrixa-journal-win32-"));
  const dir = path.join(root, "journal");
  mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dir,
    current: path.join(dir, "faults.json"),
    previous: path.join(dir, "faults.previous.json"),
  };
}
function privateFixture(t) {
  const result = fixture(t);
  const who = spawnSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  assert.equal(who.status, 0, who.stdout + who.stderr);
  const sid = who.stdout.match(/S-1-[0-9-]+/)?.[0];
  assert.ok(sid, "current user SID");
  const acl = spawnSync(
    "icacls.exe",
    [
      result.dir,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
    ],
    { encoding: "utf8" },
  );
  assert.equal(acl.status, 0, acl.stdout + acl.stderr);
  return result;
}
function replace(dir, bytes, options = {}) {
  return native.replaceCandidate(
    dir,
    options.name ?? "faults.json",
    options.temp ?? `faults.next-${randomUUID()}.json`,
    bytes,
    options.dirId ?? native.inspect(dir, ""),
    options.targetId ?? native.inspect(dir, options.name ?? "faults.json"),
    options.hook ?? (() => {}),
  );
}
function fault(code, nativeCode) {
  return (error) => {
    assert.equal(error.code, code);
    if (nativeCode !== undefined) assert.equal(error.win32Code, nativeCode);
    assert.equal(typeof error.phase, "string");
    return true;
  };
}

if (process.env.KOBRIXA_JOURNAL_WIN32_CHILD === "interrupt") {
  const dir = process.env.KOBRIXA_JOURNAL_WIN32_DIR;
  const hook = (phase) => {
    if (phase !== process.env.KOBRIXA_JOURNAL_WIN32_PHASE) return;
    writeFileSync(process.env.KOBRIXA_JOURNAL_WIN32_MARKER, phase);
    // Parent kills the process while native publication is suspended here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  };
  if (process.env.KOBRIXA_JOURNAL_WIN32_PRODUCTION_SEQUENCE === "1")
    native.durableReplaceForTest(
      dir,
      "faults.json",
      `faults.next-${randomUUID()}.json`,
      newBytes,
      hook,
    );
  else replace(dir, newBytes, { hook });
  throw new Error("interruption child unexpectedly completed");
} else {
  test("directory-link fixture cleanup preserves target bytes (not native adapter evidence)", (t) => {
    const { root, current } = fixture(t);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const retained = path.join(outside, "retained.json");
    writeFileSync(retained, oldBytes);
    // Windows creates a junction; POSIX ignores the type and creates a symlink.
    symlinkSync(outside, current, "junction");
    unlinkSync(current);
    assert.equal(existsSync(current), false);
    assert.deepEqual(readFileSync(retained), oldBytes);
    writeFileSync(current, newBytes, { flag: "wx" });
    assert.deepEqual(readFileSync(current), newBytes);
    assert.deepEqual(readdirSync(outside), ["retained.json"]);
    assert.deepEqual(readFileSync(retained), oldBytes);
  });

  test(
    "production pin mode repeatedly replaces previous/current with no phase callbacks",
    { skip: notRun },
    (t) => {
      const { dir, current, previous } = privateFixture(t);
      assert.equal(production.capabilities(dir).supported, true);
      assert.equal(production.capabilities(dir).scope, "local-fixed-NTFS");
      assert.equal(production.apiVersion, "1");
      assert.equal(production.arch, process.arch);
      assert.equal(production.replaceCandidate, undefined);
      assert.equal(production.durableReplaceForTest, undefined);
      assert.equal(production.withExclusiveFile, undefined);
      assert.equal(production.probeDirectoryFlush, undefined);
      assert.equal(production.syncDirectory(dir).flushed, true);
      const publish = (name, bytes) =>
        production.durableReplace(dir, name, `faults.next-${randomUUID()}.json`, bytes);
      let prior = oldBytes;
      let previousReceipt = publish("faults.json", prior);
      assert.equal(previousReceipt.supported, true);
      assert.equal(previousReceipt.directoryFlushed, true);
      // Three consecutive commits replace existing current; the final two also
      // replace existing previous, using the production pins and held-old handle.
      for (let revision = 2; revision <= 4; revision++) {
        const bytes = snapshot(revision, "pending");
        const backup = publish("faults.previous.json", prior);
        const currentReceipt = publish("faults.json", bytes);
        for (const receipt of [backup, currentReceipt]) {
          assert.equal(receipt.supported, true);
          assert.equal(receipt.fileFlushed, true);
          assert.equal(receipt.directoryFlushed, true);
          assert.equal(receipt.published, true);
        }
        assert.notEqual(previousReceipt.identity, currentReceipt.identity);
        assert.deepEqual(readSnapshot(current).bytes, bytes);
        assert.deepEqual(readSnapshot(previous).bytes, prior);
        previousReceipt = currentReceipt;
        prior = bytes;
      }
      assert.deepEqual(readdirSync(dir).sort(), ["faults.json", "faults.previous.json"]);
      t.diagnostic(
        `runtime=${JSON.stringify(process.versions)} production=${addonPath} test=${testAddonPath}`,
      );
    },
  );

  test(
    "production pins deny ancestor/leaf renames and preserve callback exceptions",
    { skip: notRun },
    (t) => {
      const { root, dir, current } = privateFixture(t);
      production.durableReplace(dir, "faults.json", `faults.next-${randomUUID()}.json`, oldBytes);
      const temporary = `faults.next-${randomUUID()}.json`;
      const sentinel = new Error("test callback failed");
      assert.throws(
        () =>
          native.durableReplaceForTest(dir, "faults.json", temporary, newBytes, (phase) => {
            assert.equal(phase, "after-temp-flush");
            // All pins have data/list access, so denying DELETE is share-enforced.
            for (const directory of [root, dir]) {
              assert.throws(() => renameSync(directory, `${directory}-moved`));
              assert.equal(existsSync(directory), true);
              assert.equal(existsSync(`${directory}-moved`), false);
            }
            assert.throws(() =>
              renameSync(path.join(dir, temporary), path.join(dir, "retained-temp.json")),
            );
            throw sentinel;
          }),
        (error) => error === sentinel,
      );
      assert.deepEqual(readSnapshot(current).bytes, oldBytes);
      assert.deepEqual(readSnapshot(path.join(dir, temporary)).bytes, newBytes);
      // Callback exceptions must unwind pins without throwing C++ across N-API.
      renameSync(dir, `${dir}-moved`);
      renameSync(`${dir}-moved`, dir);
    },
  );

  test("production refuses pre-existing writable handles", { skip: notRun }, (t) => {
    const { dir, current } = privateFixture(t);
    writeFileSync(current, oldBytes);
    const fd = openSync(current, "r+");
    try {
      assert.throws(
        () =>
          production.durableReplace(
            dir,
            "faults.json",
            `faults.next-${randomUUID()}.json`,
            newBytes,
          ),
        fault("EBUSY", 32),
      );
      assert.deepEqual(readFileSync(current), oldBytes);
      assert.deepEqual(readdirSync(dir), ["faults.json"]);
    } finally {
      closeSync(fd);
    }
  });

  test("production refuses another principal's writable directory ACL", { skip: notRun }, (t) => {
    const { dir, current } = privateFixture(t);
    const result = spawnSync("icacls.exe", [dir, "/grant", "*S-1-1-0:(OI)(CI)M"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.throws(() => production.capabilities(dir), fault("EUNSAFE"));
    assert.throws(
      () =>
        production.durableReplace(dir, "faults.json", `faults.next-${randomUUID()}.json`, newBytes),
      fault("EUNSAFE"),
    );
    assert.equal(existsSync(current), false);
  });

  test("production refuses unsafe leaves and oversized payloads", { skip: notRun }, (t) => {
    const { root, dir, current } = privateFixture(t);
    const outside = path.join(root, "retained.json");
    writeFileSync(outside, oldBytes);
    linkSync(outside, current);
    assert.throws(
      () =>
        production.durableReplace(dir, "faults.json", `faults.next-${randomUUID()}.json`, newBytes),
      fault("EUNSAFE"),
    );
    assert.deepEqual(readFileSync(outside), oldBytes);
    assert.throws(
      () =>
        production.durableReplace(
          dir,
          "faults.json",
          `faults.next-${randomUUID()}.json`,
          Buffer.alloc(8388609),
        ),
      fault("EINVAL"),
    );
    assert.throws(() => production.capabilities("\\\\server\\share"), fault("ENOTSUP"));
  });

  test(
    "missing native module is a load failure, never a successful barrier",
    { skip: notRun },
    (t) => {
      const { root, dir } = fixture(t);
      assert.throws(() => require(path.join(root, "missing.node")), { code: "MODULE_NOT_FOUND" });
      assert.deepEqual(readdirSync(dir), []);
      // Production validates arguments; loader missing/ABI diagnostics are unit tested.
      assert.throws(() => production.durableReplace(), { code: "EINVAL" });
    },
  );

  test(
    "successful candidate durable-replacement sequence: flushed complete bytes and new identity",
    { skip: notRun },
    (t) => {
      const { dir, current } = fixture(t);
      const phases = [];
      const initial = replace(dir, oldBytes);
      assert.equal(initial.fileFlushed, true);
      const firstId = native.inspect(dir, "faults.json");
      const result = replace(dir, newBytes, { hook: (phase) => phases.push(phase) });
      assert.deepEqual(phases, ["after-temp-flush", "after-move", "after-published-flush"]);
      assert.deepEqual(readSnapshot(current).bytes, newBytes);
      assert.notEqual(result.identity, firstId);
      assert.equal(result.identity, native.inspect(dir, "faults.json"));
      assert.equal(result.fileFlushed, true);
      assert.equal(result.published, true);
      assert.equal(result.supported, false);
      assert.equal(result.primitive, "MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)");
      assert.deepEqual(readdirSync(dir), ["faults.json"]);
      t.diagnostic(
        "Candidate syscalls succeeded; crash/power-loss durability is to be verified on a Windows runner.",
      );
    },
  );

  test(
    "old and new snapshots survive close/reopen without a torn payload",
    { skip: notRun },
    (t) => {
      const { dir, current, previous } = fixture(t);
      replace(dir, oldBytes);
      replace(dir, readFileSync(current), { name: "faults.previous.json" });
      replace(dir, newBytes);
      assert.equal(readSnapshot(previous).state, "pending");
      assert.equal(readSnapshot(current).revision, 2);
      // Model an unreadable current: retain previous as uncertain evidence, never a clean result.
      writeFileSync(current, "torn");
      assert.throws(() => readSnapshot(current), SyntaxError);
      assert.deepEqual(readSnapshot(previous).bytes, oldBytes);
    },
  );

  test(
    "real Windows delete-sharing denial preserves old bytes and staged evidence",
    { skip: notRun },
    (t) => {
      const { dir, current, previous } = fixture(t);
      replace(dir, oldBytes);
      replace(dir, oldBytes, { name: "faults.previous.json" });
      const targetId = native.inspect(dir, "faults.json");
      const temp = `faults.next-${randomUUID()}.json`;
      const phases = [];
      let attempted = false;
      native.withExclusiveFile(dir, "faults.json", () => {
        attempted = true;
        // Attribute-only identity reads are exempt from CreateFileW share checks.
        // MoveFileExW replacement on windows-2022 reports ACCESS_DENIED (5),
        // not the SHARING_VIOLATION (32) specified for conflicting CreateFileW opens.
        // Preserve the actual API error; do not recast it as EBUSY or ENOTSUP.
        assert.throws(
          () => replace(dir, newBytes, { targetId, temp, hook: (phase) => phases.push(phase) }),
          (error) => {
            t.diagnostic(
              `delete-sharing denial: ${error.message} ${error.code} Win32=${error.win32Code} phase=${error.phase} publicationState=${error.publicationState}`,
            );
            assert.equal(fault("EACCES", 5)(error), true);
            assert.equal(error.message, "MoveFileExW");
            assert.equal(error.phase, "move");
            assert.equal(error.publicationState, "uncertain");
            return true;
          },
        );
      });
      assert.equal(attempted, true);
      assert.deepEqual(phases, ["after-temp-flush"]);
      assert.equal(native.inspect(dir, "faults.json"), targetId);
      assert.deepEqual(readFileSync(current), oldBytes);
      assert.deepEqual(readSnapshot(previous).bytes, oldBytes);
      assert.deepEqual(readSnapshot(path.join(dir, temp)).bytes, newBytes);
      assert.deepEqual(
        readdirSync(dir).sort(),
        ["faults.json", "faults.previous.json", temp].sort(),
      );
      // Handle closure is real: the same operation must now succeed.
      replace(dir, newBytes);
      assert.deepEqual(readFileSync(current), newBytes);
      assert.deepEqual(readSnapshot(previous).bytes, oldBytes);
      assert.deepEqual(readSnapshot(path.join(dir, temp)).bytes, newBytes);
    },
  );

  test("conflicting CreateFileW opens report the real sharing violation", { skip: notRun }, (t) => {
    const { dir, current } = fixture(t);
    replace(dir, oldBytes);
    let reopened = false;
    native.withExclusiveFile(dir, "faults.json", () => {
      assert.throws(
        () =>
          native.withExclusiveFile(dir, "faults.json", () => {
            reopened = true;
          }),
        (error) => {
          assert.equal(fault("EBUSY", 32)(error), true);
          assert.equal(error.message, "CreateFileW");
          assert.equal(error.phase, "exclusive-file");
          assert.equal(error.publicationState, "not-published");
          return true;
        },
      );
    });
    assert.equal(reopened, false);
    native.withExclusiveFile(dir, "faults.json", () => {
      reopened = true;
    });
    assert.equal(reopened, true);
    assert.deepEqual(readFileSync(current), oldBytes);
    assert.deepEqual(readdirSync(dir), ["faults.json"]);
  });

  test(
    "real read-only destination access denial is not recast as unsupported",
    { skip: notRun },
    (t) => {
      const { dir, current } = fixture(t);
      replace(dir, oldBytes);
      chmodSync(current, 0o444);
      try {
        assert.throws(() => replace(dir, newBytes), fault("EACCES", 5));
        assert.deepEqual(readFileSync(current), oldBytes);
      } finally {
        chmodSync(current, 0o666);
      }
      replace(dir, newBytes);
      assert.deepEqual(readFileSync(current), newBytes);
    },
  );

  test(
    "directory flush probe records the actual syscall outcome without declaring support",
    { skip: notRun },
    (t) => {
      const { dir } = fixture(t);
      let result;
      try {
        result = native.probeDirectoryFlush(dir);
      } catch (error) {
        assert.ok(["open-directory", "flush-directory"].includes(error.phase));
        assert.ok(Number.isInteger(error.win32Code) && error.win32Code > 0);
        t.diagnostic(
          `DIRECTORY BARRIER UNVERIFIED: ${error.phase} ${error.code} Win32=${error.win32Code}`,
        );
      }
      if (result) {
        assert.equal(result.flushed, true);
        assert.equal(result.supported, false);
        t.diagnostic(
          "Directory FlushFileBuffers returned success; namespace/power-loss guarantee still UNVERIFIED.",
        );
      }
      assert.throws(() => production.durableReplace(), { code: "EINVAL" });
    },
  );

  for (const productionSequence of [false, true]) {
    for (const phase of ["after-temp-flush", "after-move", "after-published-flush"]) {
      test(
        `${productionSequence ? "production" : "candidate"} killed publication child: ${phase}, recover complete old/new evidence`,
        { skip: notRun, timeout: 30000 },
        async (t) => {
          const { root, dir, current, previous } = productionSequence
            ? privateFixture(t)
            : fixture(t);
          if (productionSequence) {
            production.durableReplace(
              dir,
              "faults.json",
              `faults.next-${randomUUID()}.json`,
              oldBytes,
            );
            production.durableReplace(
              dir,
              "faults.previous.json",
              `faults.backup-${randomUUID()}.json`,
              oldBytes,
            );
          } else {
            replace(dir, oldBytes);
            replace(dir, oldBytes, { name: "faults.previous.json" });
          }
          const marker = path.join(root, "phase.txt");
          const child = spawn(process.execPath, [filename], {
            env: {
              ...process.env,
              KOBRIXA_JOURNAL_WIN32_ADDON: addonPath,
              KOBRIXA_JOURNAL_WIN32_TEST_ADDON: testAddonPath,
              KOBRIXA_JOURNAL_WIN32_CHILD: "interrupt",
              KOBRIXA_JOURNAL_WIN32_PRODUCTION_SEQUENCE: productionSequence ? "1" : "0",
              KOBRIXA_JOURNAL_WIN32_DIR: dir,
              KOBRIXA_JOURNAL_WIN32_PHASE: phase,
              KOBRIXA_JOURNAL_WIN32_MARKER: marker,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          let spawnError;
          child.on("error", (error) => {
            spawnError = error;
          });
          const closed = new Promise((resolve) => child.once("close", resolve));
          try {
            const deadline = Date.now() + 15000;
            while (
              !existsSync(marker) &&
              child.exitCode === null &&
              !spawnError &&
              Date.now() < deadline
            )
              await delay(20);
            assert.equal(spawnError, undefined);
            assert.equal(existsSync(marker), true, `child never reached ${phase}: ${output}`);
            assert.equal(readFileSync(marker, "utf8"), phase);
            assert.equal(child.kill("SIGKILL"), true);
            await closed;
            assert.ok(child.exitCode !== null || child.signalCode !== null);
            assert.deepEqual(readSnapshot(previous).bytes, oldBytes);
            const staged = readdirSync(dir).filter((name) => name.startsWith("faults.next-"));
            if (phase === "after-temp-flush") {
              assert.deepEqual(readSnapshot(current).bytes, oldBytes);
              assert.equal(staged.length, 1);
              assert.deepEqual(readSnapshot(path.join(dir, staged[0])).bytes, newBytes);
            } else {
              assert.deepEqual(readSnapshot(current).bytes, newBytes);
              assert.equal(staged.length, 0);
            }
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await closed;
          }
        },
      );
    }
  }

  test(
    "refuse stale target identity before publication and retain staged bytes",
    { skip: notRun },
    (t) => {
      const { dir, current } = fixture(t);
      replace(dir, oldBytes);
      const alien = snapshot(99, "pending");
      const temp = `faults.next-${randomUUID()}.json`;
      assert.throws(
        () =>
          replace(dir, newBytes, {
            temp,
            hook(phase) {
              if (phase !== "after-temp-flush") return;
              renameSync(current, path.join(dir, "retained-old.json"));
              writeFileSync(current, alien, { flag: "wx" });
            },
          }),
        fault("ESTALE"),
      );
      assert.deepEqual(readFileSync(current), alien);
      assert.deepEqual(readFileSync(path.join(dir, temp)), newBytes);
    },
  );

  test(
    "refuse directory identity replacement and existing temp collisions",
    { skip: notRun },
    (t) => {
      const { root, dir } = fixture(t);
      const dirId = native.inspect(dir, "");
      renameSync(dir, path.join(root, "old-directory"));
      mkdirSync(dir);
      assert.throws(() => replace(dir, newBytes, { dirId }), fault("ESTALE"));
      assert.deepEqual(readdirSync(dir), []);
      const temp = `faults.next-${randomUUID()}.json`;
      writeFileSync(path.join(dir, temp), oldBytes);
      assert.throws(() => replace(dir, newBytes, { temp }), fault("EEXIST"));
      assert.deepEqual(readFileSync(path.join(dir, temp)), oldBytes);
    },
  );

  test("refuse a swapped temp identity at the pre-publication boundary", { skip: notRun }, (t) => {
    const { dir, current } = fixture(t);
    replace(dir, oldBytes);
    const temp = `faults.next-${randomUUID()}.json`;
    assert.throws(
      () =>
        replace(dir, newBytes, {
          temp,
          hook(phase) {
            if (phase !== "after-temp-flush") return;
            renameSync(path.join(dir, temp), path.join(dir, "retained-temp.json"));
            writeFileSync(path.join(dir, temp), snapshot(99, "pending"), { flag: "wx" });
          },
        }),
      fault("ESTALE"),
    );
    assert.deepEqual(readFileSync(current), oldBytes);
  });

  test(
    "post-publication identity failure stays uncertain and retains previous evidence",
    { skip: notRun },
    (t) => {
      const { dir, current, previous } = fixture(t);
      replace(dir, oldBytes);
      replace(dir, oldBytes, { name: "faults.previous.json" });
      const alien = snapshot(99, "pending");
      assert.throws(
        () =>
          replace(dir, newBytes, {
            hook(phase) {
              if (phase !== "after-move") return;
              renameSync(current, path.join(dir, "published-before-swap.json"));
              writeFileSync(current, alien, { flag: "wx" });
            },
          }),
        (error) => {
          assert.equal(error.code, "ESTALE");
          assert.equal(error.phase, "flush-published");
          assert.equal(error.publicationState, "uncertain");
          return true;
        },
      );
      assert.deepEqual(readFileSync(current), alien);
      assert.deepEqual(readSnapshot(previous).bytes, oldBytes);
      assert.deepEqual(readFileSync(path.join(dir, "published-before-swap.json")), newBytes);
    },
  );

  test("refuse ancestor and leaf reparse points", { skip: notRun }, (t) => {
    const { root, dir, current } = fixture(t);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const alias = path.join(root, "alias");
    symlinkSync(dir, alias, "junction");
    assert.throws(() => native.inspect(alias, ""), fault("EUNSAFE"));
    const child = path.join(dir, "child");
    mkdirSync(child);
    assert.throws(() => native.inspect(path.join(alias, "child"), ""), fault("EUNSAFE"));
    symlinkSync(outside, current, "junction");
    assert.throws(() => native.inspect(dir, "faults.json"), fault("EUNSAFE"));
    // Bypass the JS helper's inspection to exercise ReplaceCandidate validation too.
    assert.throws(() => replace(dir, newBytes, { targetId: "missing" }), {
      code: "EUNSAFE",
      phase: "validate",
      publicationState: "not-published",
    });
    assert.deepEqual(readdirSync(outside), []);
    // rmSync without recursive rejects a Windows directory junction with EISDIR.
    // Unlink the junction itself, preserving the target directory and its bytes.
    const retained = path.join(outside, "retained.json");
    writeFileSync(retained, oldBytes);
    unlinkSync(current);
    assert.equal(existsSync(current), false);
    assert.deepEqual(readFileSync(retained), oldBytes);
    assert.deepEqual(readdirSync(dir), ["child"]);
  });

  test("refuse hard-linked journal files before staging", { skip: notRun }, (t) => {
    const { root, dir, current } = fixture(t);
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    replace(dir, oldBytes);
    const targetId = native.inspect(dir, "faults.json");
    const linked = path.join(outside, "linked.json");
    linkSync(current, linked);
    assert.throws(() => native.inspect(dir, "faults.json"), fault("EUNSAFE"));
    assert.throws(() => replace(dir, newBytes, { targetId }), {
      code: "EUNSAFE",
      phase: "validate",
      publicationState: "not-published",
    });
    assert.deepEqual(readFileSync(current), oldBytes);
    assert.deepEqual(readFileSync(linked), oldBytes);
    assert.deepEqual(readdirSync(dir), ["faults.json"]);
  });

  test("refuse path aliases, traversal, ADS and nonlocal support", { skip: notRun }, (t) => {
    const { dir } = fixture(t);
    const dirId = native.inspect(dir, "");
    for (const name of ["../faults.json", "faults.json:stream", "faults.json.", "other.json"]) {
      assert.throws(() => replace(dir, newBytes, { name, targetId: "missing" }), fault("EINVAL"));
    }
    assert.throws(() => native.inspect("\\\\server\\share\\journal", ""), fault("ENOTSUP"));
    assert.throws(() => native.inspect(`${dir}\\..\\journal`, ""), fault("EINVAL"));
    assert.equal(native.inspect(dir, ""), dirId);
    assert.deepEqual(readdirSync(dir), []);
  });
}
