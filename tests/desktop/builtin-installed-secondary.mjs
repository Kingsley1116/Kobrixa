import assert from "node:assert/strict";

// Replay only the identified child's observations. The controller owns exit status and time.
export function collectSecondaryObservation(output, secondary) {
  const prefix = "KOBRIXA_SECONDARY ";
  const lines = output.toString().split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith(prefix.trimEnd())) continue;
    assert.ok(line.startsWith(prefix), "truncated secondary record");
    rows.push(JSON.parse(line.slice(prefix.length)));
  }
  const [entry, ...rest] = rows;
  assert.equal(entry?.phase, "installed", "secondary log order: missing installation");
  const { pid, exit } = secondary;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(entry.pid, pid);
  assert.equal(entry.beforeReady, true);
  assert.ok(Number.isFinite(entry.installedMonotonic));
  assert.equal(exit.code, 0, "secondary controller exit code");
  assert.equal(exit.signal, null);
  assert.ok(Number.isFinite(exit.at));

  // Archived producers emitted an unnumbered installation and a full exit-hook snapshot.
  if (entry.sequence === undefined && exit.pid === undefined) {
    assert.equal(rest.length, 1);
    const [hook] = rest;
    assert.equal(hook.phase, "exit");
    assert.equal(hook.pid, pid);
    assert.equal(hook.code, exit.code);
    assert.equal(hook.beforeReady, true);
    assert.equal(hook.installedMonotonic, entry.installedMonotonic);
    assert.ok(hook.exitMonotonic >= entry.installedMonotonic);
    return hook;
  }

  assert.equal(exit.pid, pid);
  assert.equal(entry.sequence, 0);
  const tail = lines.at(-1);
  assert.ok(
    !tail || !(prefix.startsWith(tail) || tail.startsWith(prefix)),
    "truncated secondary record",
  );
  const summary = {
    phase: "exit",
    pid,
    beforeReady: true,
    installedMonotonic: entry.installedMonotonic,
    workers: [],
    utilities: [],
    children: [],
    writes: [],
    locks: [],
    code: exit.code,
    exitMonotonic: exit.monotonic,
  };
  let pending, preExit;
  for (const [i, row] of rest.entries()) {
    assert.equal(row.pid, pid);
    if (row.phase === "exit") {
      assert.ok(preExit && i === rest.length - 1, "unexpected secondary exit hook");
      const { preExitMonotonic, ...snapshot } = summary;
      assert.ok(row.exitMonotonic >= preExitMonotonic && row.exitMonotonic <= exit.monotonic);
      assert.deepEqual(row, { ...snapshot, exitMonotonic: row.exitMonotonic });
      continue;
    }
    assert.equal(row.sequence, i + 1, "secondary sequence gap");
    assert.ok(!preExit, "secondary observation after pre-exit");
    switch (row.phase) {
      case "workers":
      case "utilities":
      case "children":
      case "writes":
        assert.equal(typeof row.api, "string");
        assert.ok(Array.isArray(row.arguments));
        summary[row.phase].push({ api: row.api, arguments: row.arguments });
        break;
      case "lock-request":
        assert.equal(pending, undefined, "unresolved secondary lock request");
        pending = row.sequence;
        break;
      case "lock-result":
        assert.ok(
          pending !== undefined && pending === row.request,
          "unmatched secondary lock result",
        );
        assert.equal(typeof row.acquired, "boolean");
        summary.locks.push({ acquired: row.acquired });
        pending = undefined;
        break;
      case "pre-exit":
        assert.equal(pending, undefined, "missing secondary lock result");
        assert.ok(["app.exit", "process.exit", "process.reallyExit"].includes(row.api));
        assert.equal(row.code, exit.code);
        assert.ok(
          entry.installedMonotonic <= row.monotonic &&
            row.monotonic <= exit.monotonic &&
            Number.isFinite(exit.monotonic) &&
            Number.isFinite(row.monotonic),
          "secondary exit clock",
        );
        preExit = row;
        summary.preExitMonotonic = row.monotonic;
        break;
      default:
        assert.fail("unknown secondary record: " + row.phase);
    }
  }
  assert.ok(preExit, "missing secondary pre-exit");
  return summary;
}
