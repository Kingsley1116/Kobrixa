import { enforcement, exact, alternative, nativeResult } from "./judge.mjs";
import assert from "node:assert/strict";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import {
  j,
  note,
  measured,
  subjectArgs,
  start,
  ledger,
  row,
  blocked,
  blockPrefix,
} from "./context.mjs";
import { task, validIdentity } from "./account.mjs";
import { families, roles, trials, netRow } from "./verdict.mjs";
import { install, removePF, counters } from "./pf.mjs";

const { flow } = createRequire(import.meta.url)("./client.cjs");
export async function client(t, role = "subject") {
  const args = [
    j.node,
    j.stage + "/client.cjs",
    JSON.stringify(role === "child" ? { ...t, child: j.child } : t),
  ];
  const [file, ...argv] = subjectArgs(args);
  const proc = start(file, argv);
  let stdout = "",
    stderr = "";
  proc.stdout.on("data", (b) => (stdout += b));
  proc.stderr.on("data", (b) => (stderr += b));
  const timer = setTimeout(() => proc.kill("SIGKILL"), 14000);
  try {
    const [code, signal] = await once(proc, "close");
    note("client exit", { code, signal, stderr });
    assert.equal(code, 0);
    const r = JSON.parse(stdout);
    assert.ok(validIdentity(r, role));
    return r;
  } finally {
    clearTimeout(timer);
  }
}
export async function receivers() {
  const endpoints = [];
  const routes = families.map((family) => ({
    family,
    host: family.endsWith("4") ? "127.0.0.1" : "::1",
    id: family,
  }));
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const addr of addresses) {
      if (addr.internal) continue;
      note("host interface", {
        name,
        address: addr.address,
        family: addr.family,
        scope: addr.scopeid ?? 0,
      });
      const host =
        addr.scopeid && !addr.address.includes("%") ? addr.address + "%" + name : addr.address;
      for (const proto of ["tcp", "udp"]) {
        const family = proto + (addr.family === "IPv4" ? "4" : "6");
        routes.push({ family, host, id: "host" + routes.length + family });
      }
    }
  }
  for (const { family, host, id } of routes) {
    let s;
    try {
      const events = [];
      const record = (type, remoteAddress, remotePort, nonce = null) => {
        const event = {
          type,
          at: Date.now(),
          pid: process.pid,
          uid: process.getuid(),
          family,
          host,
          port: s.address().port,
          remoteAddress,
          remotePort,
          nonce: nonce === null || /^[0-9a-f-]{36}$/i.test(nonce) ? nonce : "[unexpected payload]",
        };
        events.push(event);
        note("receiver", event);
      };
      if (family.startsWith("tcp")) {
        s = net.createServer((socket) => {
          const { remoteAddress, remotePort } = socket;
          record("accept", remoteAddress, remotePort);
          let data = "";
          socket.setTimeout(3000, () => socket.destroy());
          socket.on("error", (e) => record("error", remoteAddress, remotePort, e.code));
          socket.on("data", (b) => {
            data += b;
            if (data.length > 256) return socket.destroy();
            if (data.includes("\n")) {
              const nonce = data.trim();
              record("request", remoteAddress, remotePort, nonce);
              socket.end("reply:" + nonce + "\n");
            }
          });
        });
        s.listen(0, host);
      } else {
        s = dgram.createSocket(family);
        s.on("message", (b, peer) => {
          const nonce = b.toString();
          record("datagram", peer.address, peer.port, nonce);
          s.send("reply:" + nonce, peer.port, peer.address);
        });
        s.bind(0, host);
      }
      await once(s, "listening");
      const endpoint = { id, host, family, port: s.address().port, events, close: () => s.close() };
      endpoints.push(endpoint);
      note("listening", { host, family, port: endpoint.port, pid: process.pid });
    } catch (e) {
      note("receiver unavailable", { family, host, id, error: e.message });
    }
  }
  endpoints.expectedRoutes = routes.map((r) => r.id);
  return endpoints;
}
const used = new Set();
export async function tuple(endpoint, label) {
  const { host, family, port } = endpoint;
  // Bind a source port of the same protocol/family, release it, then require the
  // client to bind exactly that port. A collision fails the observation.
  for (let i = 0; i < 20; i++) {
    const s = family.startsWith("tcp") ? net.createServer() : dgram.createSocket(family);
    if (family.startsWith("tcp")) s.listen(0, host);
    else s.bind(0, host);
    await once(s, "listening");
    const localPort = s.address().port;
    await new Promise((resolve) => s.close(resolve));
    if (used.has(localPort)) continue;
    used.add(localPort);
    return { action: "flow", family, host, port, localPort, label, nonce: randomUUID() };
  }
  throw Error("no fresh source tuple");
}
export async function attempt(endpoint, t, invoke) {
  const index = endpoint.events.length;
  const result = await invoke(t);
  await delay(100);
  const events = endpoint.events
    .slice(index)
    .filter((e) => e.remotePort === t.localPort || e.nonce === t.nonce);
  const receipt = {
    t,
    result,
    events,
    reply:
      result.code === "REPLY" &&
      events.some(
        (e) => e.nonce === t.nonce && e.remotePort === t.localPort && e.remoteAddress === t.host,
      ),
  };
  note("flow", receipt);
  return receipt;
}
export async function control(endpoint, invoke = flow) {
  return attempt(endpoint, await tuple(endpoint, "control"), invoke);
}
async function reverse() {
  const [file, ...args] = subjectArgs([
    j.node,
    j.stage + "/client.cjs",
    JSON.stringify({ action: "reverse" }),
  ]);
  const proc = start(file, args);
  const closed = once(proc, "close");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 10000);
  try {
    let data = "";
    for await (const chunk of proc.stdout) {
      data += chunk;
      if (data.includes("\n")) break;
    }
    const target = JSON.parse(data);
    assert.ok(validIdentity(target, "subject"));
    const result = await flow({
      family: "tcp4",
      host: "127.0.0.1",
      port: target.port,
      nonce: randomUUID(),
    });
    const [code, signal] = await closed;
    return { ok: code === 0 && result.code === "REPLY", target, result, code, signal };
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
}
async function subjectControls(endpoints) {
  const baseline = {};
  for (const e of endpoints)
    for (const role of roles) {
      try {
        baseline[role + e.id] = (await control(e, (t) => client(t, role))).reply;
      } catch (error) {
        note("network baseline error", { role, family: e.family, error: error.message });
      }
    }
  return baseline;
}
export async function primitivesNetwork(endpoints, inspectPF) {
  const restored = {};
  for (const trial of trials) {
    const baseline = await subjectControls(endpoints);
    note("subject baseline", { trial, baseline });
    let installed = false;
    const jobs = [];
    try {
      if (!j.anchor) inspectPF();
      for (const role of roles)
        for (const e of endpoints) {
          jobs.push({ role, e, t: await tuple(e, "w17" + role + e.id) });
        }
      install(
        trial,
        jobs.map((job) => job.t),
      );
      installed = true;
      for (const { role, e, t } of jobs) {
        const prefix = netRow(trial, role, e.id);
        if (e.id !== e.family)
          for (const suffix of [
            ".enforcement",
            ".native",
            ...(e.family.startsWith("tcp") ? [".errno"] : []),
          ])
            ledger[prefix + suffix] ??= { status: "NOT RUN" };
        try {
          const pre = await control(e);
          const before = counters(t);
          const r = await attempt(e, t, (p) => client(p, role));
          if (e.family.startsWith("tcp") && !exact(r.result))
            row(prefix + ".errno", "FAIL", { r, corroboration: "pending" });
          const after = counters(t);
          const post = await control(e);
          const ok =
            (e.id !== e.family || j.loopbackFiltered === true) &&
            baseline[role + e.id] &&
            enforcement(before, after, r, pre, post);
          const detail = {
            baseline: baseline[role + e.id],
            before,
            after,
            pre: pre.t.nonce,
            post: post.t.nonce,
            r,
          };
          measured(prefix + ".enforcement", ok, detail);
          if (e.family.startsWith("tcp"))
            measured(prefix + ".errno", ok && exact(r.result), {
              ...detail,
              differentErrnoOnly: !!ok && alternative(r.result),
            });
        } catch (err) {
          blocked([prefix + ".enforcement", prefix + ".errno"], err.message);
        }
        try {
          const op = e.family.slice(0, 3),
            nonce = randomUUID();
          const start = e.events.length;
          const result = task(
            { action: "native", args: [op, e.host, String(e.port), nonce] },
            role,
          );
          note("native socket attempt", {
            trial,
            role,
            op,
            host: e.host,
            port: e.port,
            nonce,
            result,
          });
          await delay(100);
          const delivered = e.events
            .slice(start)
            .some((event) => event.nonce === nonce || event.type === "accept");
          measured(
            prefix + ".native",
            validIdentity(result, role) && nativeResult(result, j.uid, op) && !delivered,
            { result, delivered },
          );
        } catch (err) {
          row(prefix + ".native", "FAIL", err.message);
        }
      }
      try {
        const r = await reverse();
        measured("M4." + trial + ".reverse", r.ok, r);
      } catch (e) {
        row("M4." + trial + ".reverse", "FAIL", e.message);
      }
    } catch (error) {
      blockPrefix("M4." + trial + ".", error.message);
    } finally {
      removePF();
    }
    if (installed) restored[trial] = await subjectControls(endpoints);
  }
  const ok = trials.every((trial) =>
    roles.every((role) => families.every((f) => restored[trial]?.[role + f] === true)),
  );
  const hosts = endpoints.expectedRoutes.filter((id) => id.startsWith("host"));
  const hostKeys = hosts.flatMap((id) =>
    trials.flatMap((trial) =>
      roles.flatMap((role) =>
        [".native", ".enforcement", ...(id.includes("tcp") ? [".errno"] : [])].map(
          (suffix) => netRow(trial, role, id) + suffix,
        ),
      ),
    ),
  );
  const restoredHosts =
    hosts.length > 0 &&
    hosts.every((id) =>
      trials.every((trial) => roles.every((role) => restored[trial]?.[role + id] === true)),
    );
  const missing = hostKeys.filter((key) => ledger[key]?.status !== "PASS");
  if (hosts.length)
    measured("M4.hostRoutes", !missing.length && restoredHosts, {
      hosts,
      hostKeys,
      restoredHosts,
      differentErrnoOnly:
        restoredHosts &&
        missing.length > 0 &&
        missing.every(
          (k) =>
            k.endsWith(".errno") &&
            ledger[k]?.status === "FAIL" &&
            ledger[k]?.detail?.differentErrnoOnly === true,
        ),
    });
  else row("M4.hostRoutes", "NOT RUN", "no usable non-loopback address");
  measured("M4.restored", ok, restored);
}
