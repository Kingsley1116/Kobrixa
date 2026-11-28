import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const identity = (value) =>
  JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

// Start with the union so that patches coalesced before flush, snapshots that
// overtake an invalidation, and revisions without a mounted view remain visible.
export function joinSamples(main, renderer, patches, delivered, clock, uncertainty) {
  const buckets = new Map();
  const origins = new Map();
  const bindingOwners = new Map();
  for (const row of [...main, ...patches, ...renderer.observations]) {
    if (!row.binding || !row.owner) continue;
    const binding = identity(row.binding);
    if (!bindingOwners.has(binding)) bindingOwners.set(binding, new Map());
    bindingOwners.get(binding).set(identity(row.owner), row.owner);
  }
  function add(row, stage) {
    if (!row.binding || !Number.isSafeInteger(row.revision)) return;
    const binding = identity(row.binding);
    const known = bindingOwners.get(binding);
    const owner = row.owner ?? (known?.size === 1 ? known.values().next().value : null);
    const id = JSON.stringify([owner && identity(owner), binding, row.revision]);
    if (!buckets.has(id))
      buckets.set(id, { owner, binding: row.binding, revision: row.revision, events: {} });
    const bucket = buckets.get(id);
    (bucket.events[stage] ??= []).push(row);
  }
  const originKey = (row, at) => JSON.stringify([identity(row.owner), identity(row.binding), at]);
  for (const row of main) {
    if (row.kind !== "apply") continue;
    add(row, "origin");
    origins.set(originKey(row, row.time), row.revision);
  }
  for (const row of patches) {
    if ("observerStart" in row)
      add({ ...row, revision: origins.get(originKey(row, row.origin)) }, "observer");
    else add(row, "applyStart" in row ? "patch" : "send");
  }
  for (const row of delivered)
    add(row, "eventEntry" in row ? "entry" : "storeUpdate" in row ? "update" : "snapshot");
  for (const row of renderer.observations) if (row.kind === "apply") add(row, "commit");
  const samples = [];
  for (const { binding, revision, owner, events } of buckets.values()) {
    const one = (stage) => (events[stage]?.length === 1 ? events[stage][0] : undefined);
    const commit = one("commit"),
      origin = one("origin"),
      observer = one("observer"),
      send = one("send"),
      entry = one("entry"),
      snapshot = one("snapshot"),
      update = one("update");
    const total = owner && commit && origin ? commit.time + clock.offset - origin.time : null;
    const durations = {};
    function span(name, start, end, offset = 0) {
      if (Number.isFinite(start) && Number.isFinite(end)) durations[name] = end - start + offset;
    }
    span("patch", one("patch")?.applyStart, one("patch")?.applyEnd);
    span("awaitFlush", one("patch")?.applyEnd, origin?.time);
    span("observerDispatch", origin?.time, observer?.observerStart);
    span("observer", observer?.observerStart, observer?.observerEnd);
    span("publish", observer?.observerEnd, send?.sendStart);
    span("send", send?.sendStart, send?.sendEnd);
    span("delivery", send?.sendEnd, entry?.eventEntry, clock.offset);
    if (snapshot) {
      span("requestDispatch", entry?.eventEntry, snapshot.request);
      span("snapshotRoundTrip", snapshot.request, snapshot.arrival);
      span("stateUpdate", snapshot.arrival, update?.storeUpdate);
    } else if (entry?.pushed) span("stateUpdate", entry.eventEntry, update?.storeUpdate);
    span("reactCommit", update?.storeUpdate, commit?.time);
    const required = [
      "observerDispatch",
      "observer",
      "publish",
      "send",
      "delivery",
      "stateUpdate",
      "reactCommit",
    ];
    if (!entry?.pushed || snapshot) required.push("requestDispatch", "snapshotRoundTrip");
    const complete =
      owner &&
      total !== null &&
      required.every(
        (k) =>
          Number.isFinite(durations[k]) && durations[k] >= -(k === "delivery" ? uncertainty : 0),
      ) &&
      (!snapshot?.replyBinding || identity(snapshot.replyBinding) === identity(binding)) &&
      (!snapshot ||
        (snapshot.requestedRevision ?? commit?.applyTiming?.requestedRevision) === revision) &&
      (!commit?.applyTiming || commit.applyTiming.requestedRevision === revision) &&
      !Object.values(events).some((rows) => rows.length !== 1);
    const ranked = required
      .filter((k) => k in durations)
      .sort((a, b) => durations[b] - durations[a]);
    let stage = "incomplete or ambiguous";
    if (complete) {
      const first = ranked[0];
      const bound = (k) => (k === "delivery" ? uncertainty : 0);
      stage = ranked
        .slice(1)
        .every((k) => durations[first] - bound(first) > durations[k] + bound(k))
        ? first
        : "indistinguishable";
    }
    samples.push({ owner, binding, revision, events, durations, observerToCommitMs: total, stage });
  }
  const matched = samples
    .filter((s) => s.observerToCommitMs !== null)
    .sort((a, b) => b.observerToCommitMs - a.observerToCommitMs);
  return {
    samples,
    counts: {
      rows: samples.length,
      patch: patches.filter((r) => "applyStart" in r).length,
      observed: main.filter((r) => r.kind === "apply").length,
      matched: matched.length,
    },
    worst: matched.slice(0, 30),
  };
}

export async function summarize(directory) {
  const read = async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"));
  const report = await read("report.json");
  assert.equal(report.diagnostic, true);
  const renderer = await read("renderer-events.json");
  const main = (await readFile(path.join(directory, "main-events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const uncertainty = Math.max(
    ...report.calibration.map((s) => s.uncertainty + Math.abs(s.offset - report.clock.offset)),
  );
  const { rows, anchors } = await read("diagnostic-renderer.json");
  const result = joinSamples(
    main,
    renderer,
    await read("diagnostic-main.json"),
    rows,
    report.clock,
    uncertainty,
  );
  await writeFile(
    path.join(directory, "diagnostic-samples.json"),
    JSON.stringify({ diagnostic: true, clock: report.clock, uncertainty, anchors, ...result }),
  );
  console.log(
    JSON.stringify({
      directory,
      uncertainty,
      counts: result.counts,
      worst: result.worst.map(({ owner, binding, revision, stage, observerToCommitMs }) => ({
        owner,
        binding,
        revision,
        stage,
        observerToCommitMs,
      })),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length >= 3, "Pass one or more diagnostic load directories");
  for (const directory of process.argv.slice(2)) await summarize(directory);
}
