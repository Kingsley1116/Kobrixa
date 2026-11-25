// Compare shallow sizes and inspect actual owning edges. Synthetic VM groups
// and strings are grouped by type so string contents never become group names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
function summarize(file) {
  const {
    snapshot: { meta },
    nodes,
    edges,
    strings,
  } = JSON.parse(readFileSync(file, "utf8"));
  const fields = meta.node_fields,
    width = fields.length,
    ef = meta.edge_fields,
    ew = ef.length;
  const nodeField = (node, key) => nodes[node + fields.indexOf(key)];
  const type = (node) => meta.node_types[fields.indexOf("type")][nodeField(node, "type")];
  const name = (node) => strings[nodeField(node, "name")];
  const groups = new Map(),
    offsets = new Uint32Array(nodes.length / width + 1);
  let edgeOffset = 0;
  const owners = [];
  for (let n = 0; n < nodes.length; n += width) {
    offsets[n / width] = edgeOffset;
    edgeOffset += nodeField(n, "edge_count") * ew;
    const kind = type(n);
    const key = ["object", "native"].includes(kind) ? kind + " " + name(n) : kind;
    const group = groups.get(key) ?? { count: 0, bytes: 0 };
    group.count++;
    group.bytes += nodeField(n, "self_size");
    groups.set(key, group);
    if (kind === "object" && ["AtomicStore", "WorkerSources"].includes(name(n))) owners.push(n);
  }
  assert.equal(edgeOffset, edges.length);
  offsets[offsets.length - 1] = edgeOffset;
  function outgoing(n) {
    const result = [];
    for (let e = offsets[n / width]; e < offsets[n / width + 1]; e += ew) {
      const kind = meta.edge_types[ef.indexOf("type")][edges[e + ef.indexOf("type")]];
      const key = edges[e + ef.indexOf("name_or_index")];
      result.push({
        kind,
        edgeIndex: e,
        key: ["element", "hidden"].includes(kind) ? key : strings[key],
        to: edges[e + ef.indexOf("to_node")],
      });
    }
    return result;
  }
  // Traverse the same strong-edge graph with one owning edge removed.
  // This counts only newly unreachable shallow bytes. Shared nodes count zero.
  const weak = meta.edge_types[ef.indexOf("type")].indexOf("weak");
  const edgeType = ef.indexOf("type"),
    destination = ef.indexOf("to_node"),
    self = fields.indexOf("self_size");
  function reachableBytes(skip) {
    const seen = new Uint8Array(nodes.length / width),
      queue = new Uint32Array(seen.length);
    seen[0] = 1;
    let end = 1,
      total = 0;
    for (let i = 0; i < end; i++) {
      const id = queue[i];
      total += nodes[id * width + self];
      for (let e = offsets[id]; e < offsets[id + 1]; e += ew) {
        if (e === skip || edges[e + edgeType] === weak) continue;
        const target = edges[e + destination] / width;
        if (!seen[target]) {
          seen[target] = 1;
          queue[end++] = target;
        }
      }
    }
    return total;
  }
  const reachable = owners.length ? reachableBytes(-1) : 0;
  const paths = [];
  for (const owner of owners)
    for (const { kind, key, to, edgeIndex } of outgoing(owner)) {
      if (
        kind !== "property" ||
        !["lastImport", "entries", "inventories", "tombstones"].includes(key)
      )
        continue;
      const record = {
        owner: name(owner),
        key,
        type: name(to),
        exclusiveStrongBytes: reachable - reachableBytes(edgeIndex),
      };
      if (name(to) === "Map") {
        const table = outgoing(to).find((e) => e.key === "table");
        if (table) {
          const children = outgoing(table.to).filter((e) => e.kind !== "weak");
          record.tableStrongTargets = children.length;
          record.objectValues = children.filter(
            (e) => type(e.to) === "object" && name(e.to) === "Object",
          ).length;
          const hashNodes = children.flatMap((e) =>
            type(e.to) === "object"
              ? outgoing(e.to)
                  .filter((p) => p.key === "hash")
                  .map((p) => p.to)
              : [],
          );
          record.distinctEntryHashes = new Set(hashNodes.filter((n) => name(n) === "Hash")).size;
        }
      }
      paths.push(record);
    }
  return { groups, paths };
}
const before = summarize(process.argv[2]),
  after = summarize(process.argv[3]);
const diffs = [...new Set([...after.groups.keys(), ...before.groups.keys()])]
  .map((key) => {
    const a = after.groups.get(key),
      b = before.groups.get(key);
    return {
      key,
      count: (a?.count ?? 0) - (b?.count ?? 0),
      bytes: (a?.bytes ?? 0) - (b?.bytes ?? 0),
    };
  })
  .sort((a, b) => b.bytes - a.bytes);
console.log(
  JSON.stringify(
    {
      top: diffs.slice(0, 15),
      netShallow: diffs.reduce((sum, v) => sum + v.bytes, 0),
      before: before.paths,
      after: after.paths,
    },
    null,
    2,
  ),
);
