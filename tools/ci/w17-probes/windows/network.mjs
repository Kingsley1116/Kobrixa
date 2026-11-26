import assert from "node:assert/strict";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import {
  ctx,
  actor,
  rpc,
  note,
  row,
  ownedFile,
  waitJSON,
  restore,
  native,
  measure,
  safe,
} from "./context.mjs";
import {
  containerAbsent,
  sameFolder,
  endpoints,
  exact,
  alternative,
  join,
  comparator,
} from "./verdict.mjs";
const { flow } = createRequire(import.meta.url)("./client.cjs");
const used = new Set();
export async function receivers() {
  ctx.listeners = [];
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => !i.internal);
  const locations = {
    loop4: "127.0.0.1",
    loop6: "::1",
    routed4: ips.find((i) => i.family === "IPv4")?.address,
    routed6: ips.find((i) => i.family === "IPv6" && !i.scopeid)?.address,
  };
  ctx.advertised = Object.entries(locations).flatMap(([location, host]) =>
    ["tcp", "udp"].flatMap((protocol) => {
      if (host) return [{ location, host, protocol, label: location + "." + protocol }];
      note("interface unavailable", { location, protocol });
      return [];
    }),
  );
  note("advertised receivers", ctx.advertised);
  for (const tuple of ctx.advertised) {
    try {
      const result = await rpc("receiver", tuple);
      note(result.wsa === 0 ? "receiver" : "receiver unavailable", {
        ...tuple,
        ...result,
        offHost: false,
      });
      if (result.wsa === 0 && result.port > 0)
        ctx.listeners.push({
          ...tuple,
          port: result.port,
          pid: result.pid,
          source: tuple.host,
          events: [],
        });
    } catch (e) {
      note("receiver unavailable", { ...tuple, wsa: null, error: safe(e) });
    }
  }
  if (locations.routed6) {
    const bound = ctx.listeners.filter((e) => e.location === "routed6").length;
    row("interface.routed6", bound === 2 ? "PASS" : "FAIL", { address: locations.routed6, bound });
  }
}
async function drain(e) {
  const records = await rpc("receiver-events", { label: e.label });
  // The same records have already been streamed to the controller journal.
  e.events.push(...records);
  assert.ok(!e.events.some((event) => event.event === "receiver stopped"), "Receiver stopped");
}
export async function fresh(e) {
  for (let i = 0; i < 64; i++) {
    const reserved = await rpc("receiver", { host: e.source, protocol: e.protocol, reserve: true });
    if (reserved.wsa !== 0 || !(reserved.port > 0)) {
      note("source reservation failed", {
        label: e.label,
        host: e.source,
        protocol: e.protocol,
        ...reserved,
      });
      throw Error("Source reservation failed");
    }
    const localPort = reserved.port;
    if (used.has(localPort)) continue;
    used.add(localPort);
    return {
      action: "flow",
      host: e.host,
      source: e.source,
      port: e.port,
      protocol: e.protocol,
      localPort,
      nonce: randomUUID(),
    };
  }
  throw Error("No fresh source port");
}
const delivery = (e, t) =>
  e.events.filter((x) => x.remotePort === t.localPort || x.nonce === t.nonce);
const reply = (e, t) =>
  delivery(e, t).some(
    (x) => x.remoteAddress === t.source && x.remotePort === t.localPort && x.nonce === t.nonce,
  );
async function controller(e) {
  try {
    const t = await fresh(e),
      r = await flow(t);
    note("controller flow", { label: e.label, t, r });
    await drain(e);
    const ok = r.code === "REPLY" && reply(e, t);
    note("controller positive", { t, r, ok });
    return ok;
  } catch (error) {
    note("controller bracket unavailable", { label: e.label, error: safe(error) });
    return false;
  }
}
export const subjectRun =
  (who, container = false) =>
  (task) =>
    actor(task, { child: who === "child", container });
export async function trial(
  prefix,
  who,
  invoke,
  { denied = false, ids = null, baseline = {}, nativeToo = true, container = false } = {},
) {
  const evidence = {};
  const specs = [];
  for (const e of ctx.listeners) {
    try {
      const t = await fresh(e),
        n = await fresh(e),
        pre = await controller(e);
      specs.push({ e, t, n, pre });
    } catch (error) {
      note("tuple preparation failed", { prefix, who, label: e.label, error: safe(error) });
    }
  }
  const start = Date.now();
  const results = await invoke({ action: "batch", tasks: specs.map((v) => v.t) });
  note("Node events before native trials", {
    prefix,
    who,
    start,
    attempts: specs.map((s, i) => ({ t: s.t, result: results[i] })),
  });
  let natives = [];
  try {
    if (nativeToo)
      natives = await invoke({
        action: "batch",
        tasks: specs.map(({ e, n }) => ({
          action: "native",
          child: who === "child",
          args: ["flow", e.protocol, e.host, String(e.port), String(n.localPort), n.nonce],
        })),
      });
  } catch (e) {
    note("native trial error", { prefix, who, error: safe(e) });
  }
  note("native batch results", {
    prefix,
    who,
    attempts: specs.map(({ e, n }, i) => ({ label: e.label, t: n, result: natives[i] ?? null })),
  });
  await sleep(200);
  for (const [i, { e, t, n, pre }] of specs.entries()) {
    const result = results[i] ?? {},
      osResult = natives[i],
      post = await controller(e),
      key = who + "." + e.label;
    const received = delivery(e, t),
      rawReceived = delivery(e, n);
    let events = null,
      matched = [],
      rawMatched = [];
    const filter = ids?.[e.host.includes(":") ? "v6" : "v4"];
    if (denied) {
      try {
        events = await rpc("events", { port: e.port });
      } catch (err) {
        note("Security query failed", { error: safe(err) });
      }
      const filters = container
        ? [
            ...new Set(
              (events ?? [])
                .filter(
                  (v) =>
                    Number(v.ProcessID) === result.pid ||
                    Number(v.ProcessID) === osResult?.token?.pid,
                )
                .map((v) => v.FilterRTID),
            ),
          ]
        : [filter];
      for (const id of filters) {
        if (container) {
          let confirmed = false;
          try {
            confirmed = await rpc("container-filter", {
              id,
              ipv6: e.host.includes(":"),
              sid: ctx.containerSid,
            });
          } catch (err) {
            note("filter lookup error", { id, error: safe(err) });
          }
          note("AppContainer block filter", { id, confirmed, host: e.host });
          if (!confirmed) continue;
        }
        matched.push(...join(events, t, result.pid, id, start, Date.now()));
        if (osResult)
          rawMatched.push(...join(events, n, osResult.token?.pid, id, start, Date.now()));
      }
    }
    const kernelIdentity =
      !nativeToo ||
      (osResult?.exit === 0 &&
        osResult.token?.sid === ctx.accounts.subject.sid &&
        (container
          ? osResult.token.isContainer === 1 &&
            osResult.token.container === ctx.containerSid &&
            osResult.token.capabilities === 0
          : osResult.token.isContainer === 0));
    const valid =
      kernelIdentity &&
      Number.isInteger(result.pid) &&
      result.pid > 0 &&
      (who === "subject" || who === "child"
        ? result.exe?.toLowerCase() === (who === "child" ? ctx.child : ctx.node).toLowerCase()
        : result.pid === ctx.productPids?.[who]);
    const ok =
      valid &&
      pre &&
      post &&
      (denied
        ? baseline[key] === true &&
          received.length === 0 &&
          matched.length > 0 &&
          !(result.events ?? []).some((x) => x.event === "CONNECTED") &&
          (!nativeToo ||
            (rawReceived.length === 0 &&
              Number.isInteger(osResult.wsa) &&
              osResult.wsa !== 0 &&
              ["connect", "send", "reply"].includes(osResult.step) &&
              (e.protocol !== "tcp" || osResult.step === "connect") &&
              rawMatched.length > 0))
        : result.code === "REPLY" &&
          reply(e, t) &&
          (!nativeToo || (osResult?.wsa === 0 && osResult.step === "reply" && reply(e, n))));
    evidence[key] =
      prefix === "firewall"
        ? comparator({
            pre,
            post,
            valid,
            node: result,
            native: osResult,
            nodeReply: reply(e, t),
            nativeReply: reply(e, n),
            nodeEvents: received.length,
            nativeEvents: rawReceived.length,
            protocol: e.protocol,
          })
        : ok;
    note("network attempt", {
      prefix,
      key,
      t,
      n: nativeToo ? n : null,
      start,
      pre,
      post,
      received,
      rawReceived,
      result,
      osResult,
      filter,
      matched,
      rawMatched,
      events,
    });
    if (denied) {
      row(prefix + "." + key + ".block", ok ? "PASS" : "FAIL", {
        baseline: baseline[key] ?? null,
        correlated: matched.length,
        native: osResult?.wsa ?? null,
        delivery: received.length,
      });
      if (e.protocol === "tcp")
        row(prefix + "." + key + ".errno", ok && exact(result) ? "PASS" : "FAIL", {
          code: result.code,
          elapsed: result.elapsed,
          differentErrnoOnly: ok && alternative(result),
        });
    }
  }
  return evidence;
}
export async function both(prefix, opts = {}) {
  const all = {};
  for (const who of ["subject", "child"]) {
    try {
      Object.assign(all, await trial(prefix, who, subjectRun(who, opts.container), opts));
    } catch (e) {
      note("actor network failure", { prefix, who, error: safe(e) });
    }
  }
  return all;
}
export function complete(map, roles = ["subject", "child"]) {
  return (
    roles.every((w) =>
      [...endpoints, ...ctx.advertised.map((e) => e.label)].every((e) => map[w + "." + e] === true),
    ) && Object.values(map).every((v) => v === true)
  );
}
export async function reverse(container) {
  const ready = ownedFile();
  const p = await actor({ action: "reverse", ready }, { asyncStart: true, container });
  const info = await waitJSON(ready);
  note("reverse ready", { container, requestedPid: p.pid, info });
  assert.equal(p.pid, info.pid);
  const tuple = {
    protocol: "tcp",
    host: "127.0.0.1",
    port: info.port,
    nonce: randomUUID(),
  };
  const r = await flow(tuple);
  note("reverse flow", { container, tuple, info, r });
  assert.equal(r.code, "REPLY");
  const exit = await p.wait();
  note("reverse wait", { container, pid: p.pid, exit });
  assert.deepEqual(exit, { wait: 0, exit: 0 });
  return { info, r };
}
export async function policy(arm) {
  await measure("audit." + process.argv[2] + "." + arm, async () => ({
    setting: await rpc("audit"),
  }));
  if (arm === "container") {
    const { entries } = await rpc("state");
    if (!entries.length) {
      const before = await native(["container-query", ctx.name], { desktop: false });
      assert.equal(before.token.sid, ctx.accounts.subject.sid);
      assert.match(before.container, /^S-1-15-2-/);
      assert.ok(containerAbsent(before), "AppContainer pre-creation absence unverified");
      await rpc("intent", {
        kind: "container",
        data: { name: ctx.name, owner: before.token.sid, sid: before.container, before },
      });
      const r = await native(["container-create", ctx.name]);
      assert.equal(r.createResult, 0, "AppContainer creation was not confirmed");
      assert.equal(r.token.sid, before.token.sid);
      assert.equal(r.container, before.container);
      assert.ok(
        sameFolder(r.folder, before.expectedFolder),
        "Created folder differs from preflight",
      );
      assert.match(r.folderId, /^\d+\/\d+$/);
      ctx.containerSid = r.container;
      await rpc("container-owned", { sid: r.container, folder: r.folder, folderId: r.folderId });
    } else {
      assert.equal(entries.length, 1);
      const current = await native(["container-query", ctx.name], { desktop: false });
      assert.equal(current.token.sid, entries[0].data.owner);
      assert.equal(current.container, entries[0].data.sid);
      assert.ok(
        entries[0].data.created &&
          current.mapping === 0 &&
          current.query === 0 &&
          current.folderError === 0 &&
          current.expectedFolderError === 0 &&
          sameFolder(current.folder, entries[0].data.before.expectedFolder) &&
          sameFolder(current.folder, entries[0].data.folder),
      );
      ctx.containerSid = current.container;
    }
    assert.match(ctx.containerSid, /^S-1-15-2-/);
    const lines = await rpc("exemptions");
    note("loopback exemptions", { lines });
    assert.ok(!lines.join("\n").toLowerCase().includes(ctx.containerSid.toLowerCase()));
    const transactions = [];
    for (const [dir, rights] of [
      [ctx.stage, "ReadAndExecute"],
      [ctx.bin, "ReadAndExecute"],
      [ctx.stage + "\\aliases", "ReadAndExecute"],
      [ctx.stage + "\\plans", "ReadAndExecute"],
      [ctx.accounts.subject.home, "Modify"],
      [ctx.stage + "\\negative", "ReadAndExecute"],
    ]) {
      const installed = await rpc("acl", {
        path: dir,
        sid: ctx.containerSid,
        rights,
        inherit:
          dir === ctx.stage || dir.endsWith("\\aliases")
            ? "None"
            : "ContainerInherit,ObjectInherit",
        type: "Allow",
        scope: "container",
      });
      transactions.push(installed.id);
    }
    const id = await native(["window"], { container: true });
    assert.equal(id.token.sid, ctx.accounts.subject.sid);
    assert.equal(id.token.container, ctx.containerSid);
    assert.equal(id.token.isContainer, 1);
    assert.equal(id.token.capabilities, 0);
    return { transactions, container: ctx.containerSid };
  }
  const ids = await rpc("wfp");
  note("WFP filters", {
    ...ids,
    layers: ["ALE_AUTH_CONNECT_V4", "ALE_AUTH_CONNECT_V6"],
    action: "BLOCK",
    dynamic: true,
  });
  return { ...ids, transactions: [ids.id] };
}
export async function stopPolicy(arm) {
  assert.equal(await rpc("count"), 0, "Active owned processes before policy release");
  const receipts = arm === "wfp" ? await restore("wfp") : await restore("acl", "container");
  await restore("audit");
  return receipts;
}
