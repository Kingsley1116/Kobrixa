import assert from "node:assert/strict";
import path from "node:path";
import { BroadcastChannel } from "node:worker_threads";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { launch } from "./import-worker-host.mjs";
import { syntheticImportDescriptor as descriptor } from "../../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";

const [root, mode, lease, input] = process.argv.slice(2);
const config = JSON.parse(input);
const profile = {
  hostEpoch: randomUUID(),
  assertHeld() {
    assert.equal(readFileSync(path.join(root, "host.lock"), "utf8"), lease);
  },
};
const channel = new BroadcastChannel(lease);
channel.unref();
channel.onmessage = ({ data }) => process.send({ ...data, epoch: profile.hostEpoch });
if (mode === "matrix") {
  writeFileSync(path.join(root, "cut-config"), JSON.stringify({ ...config, lease }));
  writeFileSync(path.join(root, "fault"), "process-steps");
  writeFileSync(path.join(root, "cut-trace"), "");
}
let control;
const f = await launch(root, (c) => (control = c), descriptor, "ready", profile);
const run = () => f.coordinator.run(descriptor, new AbortController().signal);
const { backend, owner } = f;
try {
  if (mode === "matrix") {
    if (!config.recovery) {
      const result = await run();
      assert.deepEqual(result, {
        state: config.failure ? "blocked" : "complete",
        completedItems: config.failure ? 1 : 2,
        totalItems: 2,
      });
      const { value: q, ok } = await backend.evidence.quota(owner);
      assert.equal(ok, true);
      assert.equal(q.temporaryBytes, 0);
      assert.equal(q.reservedBytes, 0);
    }
    assert.ok(!config.cut, "missed cut " + config.cut);
    process.send({ kind: "reference" });
  } else if (mode === "seed" || mode === "write") {
    let plan, sibling;
    const inventory = backend.sources.inventory;
    backend.sources.inventory = async (...args) => {
      const result = await inventory(...args);
      result.entries.sort((a, b) => a.key.localeCompare(b.key));
      return result;
    };
    const planImport = backend.imports.plan;
    backend.imports.plan = async (owner, value) => {
      plan = value;
      return planImport(owner, value);
    };
    if (mode === "seed") {
      const reserve = backend.engine.reserve;
      backend.engine.reserve = async (ticket, ...args) => {
        if (sibling && ticket.target.kind === "record") {
          process.send({ kind: "armed", ticket, sibling, plan });
          process.send({
            kind: "cut",
            point: "pending",
            ticket: ticket.id,
            epoch: owner.hostEpoch,
          });
          await new Promise(() => {});
        }
        return reserve(ticket, ...args);
      };
    }
    const publish = backend.engine.publish;
    backend.engine.publish = async (ticket) => {
      if (ticket.target.kind !== "record") return publish(ticket);
      if (!sibling) {
        const result = await publish(ticket);
        assert.equal(result.disposition, "committed");
        sibling = ticket;
        return result;
      }
      for (const [point, action] of [
        [config.failure, "fail"],
        ...config.points.map((p) => [p, "pause"]),
      ]) {
        if (!point) continue;
        const ack = control.reached("armed/" + point);
        control.arm(point, action);
        await ack;
      }
      process.send({ kind: "armed", ticket, sibling, plan });
      for (const point of config.points)
        void control.reached(point).then(() => {
          const event = control.trace().at(-1);
          assert.equal(event.ticket, ticket.id);
          process.send({ kind: "cut", point, ticket: ticket.id, epoch: owner.hostEpoch });
        });
      return publish(ticket);
    };
    await run();
    throw Error("writer returned before the requested cut");
  } else {
    const { plan, ticket, sibling } = config;
    const ns = path.join(
      root,
      "plugins",
      "persistence-v1",
      "namespaces",
      createHash("sha256").update(owner.sourceKey).digest("hex"),
    );
    const load = async () => {
      const value = await backend.imports.load(owner, plan.id);
      const digest = createHash("sha256").update(plan.id).digest("hex");
      const head = JSON.parse(readFileSync(path.join(ns, "imports", digest + ".json")));
      assert.deepEqual(head.target, { kind: "import", key: plan.id });
      const bytes = readFileSync(path.join(ns, "imports", "objects", head.object));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), head.sha256);
      assert.deepEqual(JSON.parse(bytes), { formatVersion: 1, ...value });
      return value;
    };
    const journal = await load();
    assert.deepEqual(journal.plan, plan);
    assert.deepEqual(journal.items[0].publicationTicket, sibling);
    assert.equal(journal.items[0].receipt.commitId, sibling.id);
    if (mode === "retry" || mode === "published") {
      if (mode === "retry") assert.equal(journal.items[1].state, "pending");
      assert.deepEqual(journal.items[1].publicationTicket, ticket);
      if (mode === "retry") assert.equal(journal.items[1].receipt, null);
    }
    async function visible(expected) {
      const records = (await backend.reads.list(owner, { limit: 64 })).entries;
      assert.deepEqual(records.map((r) => r.id).sort(), expected.map((t) => t.target.id).sort());
      for (const t of expected) {
        const item = plan.items.find((i) => i.ticket.target.id === t.target.id);
        const r = records.find((r) => r.id === t.target.id);
        assert.equal(r.revision, t.metadata.record.revision);
        const pin = await backend.reads.open(owner, r.id, r.revision);
        try {
          const chunks = [];
          for (let offset = 0; offset < r.byteLength; offset += 262144)
            chunks.push(await backend.reads.read(owner, pin, offset, 262144));
          const bytes = Buffer.concat(chunks);
          assert.deepEqual(bytes, readFileSync(path.join(root, "legacy", item.key)));
          assert.equal(createHash("sha256").update(bytes).digest("hex"), item.mappedSha256);
          const record = path.join(ns, "records", r.id);
          const head = JSON.parse(readFileSync(path.join(record, "head.json")));
          assert.equal(head.receipt.commitId, t.id);
          assert.deepEqual(await backend.imports.reconcile(t), {
            disposition: "committed",
            receipt: head.receipt,
          });
          assert.deepEqual(readdirSync(path.join(record, "objects")), [head.object]);
          assert.deepEqual(readFileSync(path.join(record, "objects", head.object)), bytes);
        } finally {
          await backend.reads.close(owner, pin);
        }
      }
    }
    if (mode === "retry") {
      assert.equal(existsSync(path.join(ns, "records", ticket.target.id, "head.json")), false);
      assert.deepEqual(await backend.imports.reconcile(ticket), { disposition: "not-committed" });
    }
    const { value: quota, ok } = await backend.evidence.quota(owner);
    assert.equal(ok, true);
    const retainedBytes = readdirSync(path.join(ns, "quarantine"))
      .filter((name) => name.endsWith(".prepublish.bin"))
      .reduce((n, name) => n + statSync(path.join(ns, "quarantine", name)).size, 0);
    assert.equal(quota.temporaryBytes, retainedBytes);
    assert.equal(quota.reservedBytes, 0);
    const evidencePath = path.join(ns, "quarantine", ticket.id + ".prepublish.bin");
    if (existsSync(evidencePath)) {
      assert.deepEqual(
        readFileSync(evidencePath),
        readFileSync(path.join(root, "legacy", plan.items[1].key)),
      );
      assert.equal(
        JSON.parse(readFileSync(path.join(ns, "quarantine", ticket.id + ".prepublish-head")))
          .receipt.commitId,
        ticket.id,
      );
      assert.ok(quota.temporaryBytes >= plan.items[1].byteLength);
    }
    await visible(mode === "retry" ? [sibling] : [sibling, ticket]);
    assert.deepEqual(await run(), { state: "complete", completedItems: 2, totalItems: 2 });
    const final = await load();
    assert.deepEqual(final.plan, plan);
    assert.equal(final.complete, true);
    const fresh = final.items[1].publicationTicket;
    assert.equal(final.items[1].receipt.commitId, fresh.id);
    if (mode === "retry") {
      assert.notEqual(fresh.id, ticket.id);
      assert.equal(fresh.owner.hostEpoch, owner.hostEpoch);
    } else assert.deepEqual(fresh, ticket);
    await visible([sibling, fresh]);
    process.send({ kind: "complete", ticket: fresh, epoch: owner.hostEpoch });
  }
} finally {
  channel.close();
  await backend.dispose();
}
