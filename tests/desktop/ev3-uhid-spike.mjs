import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const source = fileURLToPath(new URL("fixtures/ev3-uhid/peer.c", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = path.join(root, "apps/desktop/out", `Kobrixa-linux-${process.arch}`);
const unit = "kobrixa-uhid-spike.service";
const name = "Kobrixa UHID spike";
const gates = { G1, G2, G3, G4 };

function run(command, ...args) {
  console.log(JSON.stringify([command, ...args]));
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60000 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} exit ${result.status} signal ${result.signal}`);
  return result.stdout;
}

async function G1() {
  // Collect all diagnostics even when the module lookup or insertion fails.
  const errors = [];
  for (const args of [
    ["uname", "-a"],
    ["modinfo", "uhid"],
    ["sudo", "-n", "modprobe", "uhid"],
    ["udevadm", "settle"],
    ["ls", "-l", "/dev/uhid"],
  ]) {
    try {
      run(...args);
    } catch (error) {
      errors.push(error.message);
    }
  }
  console.log(
    "Pre-create hidraw nodes",
    (await readdir("/dev")).filter((n) => /^hidraw\d+$/.test(n)),
  );
  assert.deepEqual(errors, []);
  assert.ok((await stat("/dev/uhid")).isCharacterDevice());
}

async function G2(dir) {
  const peer = path.join(tmpdir(), "ev3-uhid-peer");
  const trace = path.join(dir, "trace.log");
  assert.equal((await stat(trace)).size, 0);
  run("cc", "-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", peer);
  run(
    "sudo",
    "-n",
    "systemd-run",
    "--expand-environment=no",
    "--unit=" + unit,
    "--property=StandardOutput=append:" + trace,
    "--property=StandardError=inherit",
    "/bin/sh",
    "-ec",
    'exec 3<>/dev/uhid; exec /usr/bin/setpriv --reuid="$1" --regid="$2" --clear-groups --no-new-privs "$3" --fd3',
    "sh",
    String(process.getuid()),
    String(process.getgid()),
    peer,
  );
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    for (const node of (await readdir("/dev")).filter((n) => /^hidraw\d+$/.test(n))) {
      const event = await readFile(`/sys/class/hidraw/${node}/device/uevent`, "utf8");
      if (!event.includes("HID_UNIQ=kobrixa-uhid-spike\n")) continue;
      console.log(event);
      assert.match(event, /^HID_ID=0003:00000694:00000005$/im);
      assert.match(event, /^HID_NAME=Kobrixa UHID spike$/m);
      const device = path.join("/dev", node);
      run("udevadm", "settle");
      run("stat", device);
      run("sudo", "-n", "chown", String(process.getuid()), device);
      run("sudo", "-n", "chmod", "u+rw", device);
      run("stat", device);
      assert.ok((await stat(device)).isCharacterDevice());
      await access(device, constants.R_OK | constants.W_OK);
      return { device, uid: process.getuid() };
    }
    await delay(100);
  }
  throw new Error("No matching hidraw device appeared");
}

async function G3(dir, report) {
  const { extractAll } = await import("@electron/asar");
  const { HidConnection } = await import("../../packages/device/dist/usb.js");
  const { readMonitor } = await import("../../packages/device/dist/monitor.js");
  const extracted = await mkdtemp(path.join(tmpdir(), "uhid-asar-"));
  const archive = path.join(bundle, "resources/app.asar");
  extractAll(archive, extracted);
  const load = createRequire(path.join(extracted, "package.json"));
  const hid = load("node-hid");
  const devices = await hid.devicesAsync(0x0694, 5);
  console.log("devicesAsync", devices);
  const device = devices.find((d) => d.path === report.G2.observation.device);
  assert.equal(device?.product, name);
  assert.equal(device.vendorId, 0x0694);
  assert.equal(device.productId, 5);
  assert.equal(device.serialNumber, "kobrixa-uhid-spike");
  const addon = Object.keys(load.cache).find(
    (f) =>
      f.startsWith(extracted + "/node_modules/node-hid/prebuilds/HID_hidraw-linux-") &&
      f.endsWith(".node"),
  );
  assert.ok(addon, "Expected the extracted package's hidraw prebuild");
  console.log("Packaged loader and addon", load.resolve("node-hid"), addon);
  const connection = new HidConnection(new hid.HID(device.path));
  const signal = AbortSignal.timeout(8000);
  try {
    const readings = [];
    for (let i = 0; i < 2; i++) {
      const snapshot = await readMonitor(connection, signal);
      console.log(JSON.stringify(snapshot));
      const input = snapshot.inputs[0];
      assert.equal(input.state, "ready");
      assert.equal(input.type, 29);
      assert.equal(input.mode, 0);
      assert.ok(Number.isFinite(input.values[0]));
      readings.push(input.values[0]);
    }
    assert.notEqual(...readings);
    return { archive, addon, readings };
  } finally {
    await connection.close();
  }
}

// A probe opened by enumeration alone can OPEN/CLOSE without a VM exchange.
export function observedExchange(trace) {
  if (/ REJECT$/m.test(trace)) return false;
  const match =
    /^\d+\.\d{9} OPEN\n\d+\.\d{9} REQUEST ((?:[0-9a-f]{2})+)\n\d+\.\d{9} REPLY ((?:[0-9a-f]{2})+)\n/m.exec(
      trace,
    );
  if (!match) return false;
  const raw = Buffer.from(match[1], "hex");
  const request = raw[0] === 0 ? raw.subarray(1) : raw;
  const reply = Buffer.from(match[2], "hex");
  if (request.length < 7 || reply.length !== 512) return false;
  const length = request.readUInt16LE();
  const globals = request.readUInt16LE(5);
  return (
    length >= 5 &&
    length + 2 <= request.length &&
    request[4] === 0 &&
    reply.readUInt16LE(2) === request.readUInt16LE(2) &&
    reply[4] === 2 &&
    globals === 376 &&
    reply.readUInt16LE(0) === globals + 3
  );
}

// Runs in the inspected renderer. All actions go through the installed controls.
function devicePanelStep(step, product) {
  const pane = document.querySelector(".plugin-tools-pane [role=tabpanel]");
  const click = (button) => {
    if (!button || button.disabled || !button.getClientRects().length) return false;
    button.click();
    return true;
  };
  switch (step) {
    case "tools": {
      const toggle = document.querySelector(".plugin-tools-toggle");
      return toggle?.getAttribute("aria-pressed") === "true" || click(toggle);
    }
    case "device":
      return click(
        [...document.querySelectorAll(".plugin-tools-pane [role=tab]")].find((tab) =>
          ["EV3 device", "EV3 裝置"].includes(tab.title),
        ),
      );
    case "open":
      return click(pane?.querySelector(":scope > button:not([data-close-contribution])"));
    case "discover":
      return click(pane?.querySelector('[data-ui-node="discover-action"] button'));
    case "refresh":
      return click(pane?.querySelector('[data-ui-node="refresh-action"] button'));
    case "candidate":
    case "select": {
      const rows = pane?.querySelectorAll('[data-ui-node="candidates"] tbody tr') ?? [];
      const row = [...rows].find(
        (r) => r.cells[0]?.textContent === product && r.cells[1]?.textContent === "usb",
      );
      return step === "candidate" ? row?.textContent : click(row?.querySelector("button"));
    }
    case "connected": {
      const text = pane?.querySelector('[data-ui-node="connection"]')?.textContent;
      return text?.includes(product + " · connected") && text;
    }
  }
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function G4(dir, report) {
  const { installedEnvironment, installedLaunchCommand } =
    await import("./builtin-process-installed.mjs");
  const { assertInstalledLinuxNetwork } = await import("./builtin-installed-linux.mjs");
  const { connect, until, waitForRendererTarget } = await import("./builtin-installed-client.mjs");
  const { copyDesktopBundle } = await import("../../tools/release/macos-test-bundle.mjs");
  assertInstalledLinuxNetwork(networkInterfaces());
  assert.equal(process.getuid(), report.G2.observation.uid);
  const work = await mkdtemp(path.join(tmpdir(), "kobrixa-installed-product-"));
  const installed = path.join(work, "installed");
  await copyDesktopBundle(bundle, installed, "linux");
  const emptyPath = path.join(work, "empty-path");
  await mkdir(emptyPath);
  // On the hosted checkout, all workspace dependencies and the git dir live under root.
  const checkout = await realpath(root);
  const dependency = await realpath(
    createRequire(path.join(root, "apps/desktop/package.json")).resolve("zod/package.json"),
  );
  assert.ok(dependency.startsWith(checkout + "/"));
  const common = run("git", "rev-parse", "--git-common-dir").trim();
  const deniedRoots = [
    ...new Set([checkout, path.dirname(await realpath(path.resolve(root, common)))]),
  ];
  const launch = installedLaunchCommand(
    { isolated: true, deniedRoots, executable: path.join(installed, "kobrixa") },
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(work, "profile")}`,
    ],
  );
  console.log(JSON.stringify(launch));
  const child = spawn(launch.file, launch.args, {
    cwd: work,
    env: installedEnvironment(process.env, emptyPath),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let output = "",
    client,
    launchError;
  child.on("error", (e) => {
    launchError = e;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      process.stdout.write(b);
      output = (output + b).slice(-65536);
    });
  const check = () => {
    if (launchError) throw launchError;
    assert.ok(child.exitCode === null && child.signalCode === null, "Packaged app exited");
  };
  let observation;
  try {
    const endpoint = await until(
      () => {
        check();
        return output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
      },
      "DevTools",
      30000,
    );
    const page = await waitForRendererTarget(endpoint, { evidence: {}, check });
    console.log("Renderer", page.url);
    assert.equal(await realpath(`/proc/${child.pid}/exe`), path.join(installed, "kobrixa"));
    const status = await readFile(`/proc/${child.pid}/status`, "utf8");
    console.log(status);
    assert.match(status, /^NoNewPrivs:\s+1$/m, "Landlock launcher must set no_new_privs");
    const profile = await readFile(`/proc/${child.pid}/attr/current`, "utf8");
    console.log("AppArmor", profile.trim());
    const restriction = await readFile(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "utf8",
    ).catch((error) => {
      if (error.code === "ENOENT") return "absent";
      throw error;
    });
    if (restriction.trim() === "1") assert.match(profile, /^kobrixa-installed-test(?:\s|$)/);
    assert.ok(
      fileURLToPath(page.url.split("#")[0]).startsWith(
        path.join(installed, "resources/app.asar") + "/",
      ),
    );
    client = await connect(page.webSocketDebuggerUrl);
    await client.send("Page.bringToFront");
    const step = (action) =>
      client.js(
        `(${devicePanelStep.toString()})(${JSON.stringify(action)}, ${JSON.stringify(name)})`,
      );
    const wait = (action) =>
      until(
        () => {
          check();
          return step(action);
        },
        "EV3 panel " + action,
        30000,
      );
    await wait("tools");
    await wait("device");
    let requestedOpen = false;
    await until(
      async () => {
        check();
        if (await step("discover")) return true;
        if (!requestedOpen) requestedOpen = await step("open");
        return false;
      },
      "open EV3 device panel and click Discover",
      30000,
    );
    console.log("Discovered row", await wait("candidate"));
    const traceFile = path.join(dir, "trace.log");
    const offset = (await stat(traceFile)).size;
    await wait("select");
    const connection = await wait("connected");
    console.log(connection);
    let refreshed = false;
    await until(async () => {
      if (observedExchange((await readFile(traceFile)).subarray(offset).toString())) return true;
      check();
      if (!refreshed) refreshed = await step("refresh");
      return false;
    }, "fresh peer open, request and reply");
    observation = { renderer: page.url, connection, traceOffset: offset };
  } finally {
    if (client) {
      try {
        console.log(
          "Final EV3 panel",
          await client.js(
            `document.querySelector('.plugin-tools-pane [role=tabpanel]')?.innerText`,
          ),
        );
      } catch (error) {
        console.error("Final panel unavailable", error.message);
      } finally {
        client.close();
      }
    }
    signalGroup(child, "SIGTERM");
    const timeout = setTimeout(() => signalGroup(child, "SIGKILL"), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  }
  const tail = async () =>
    (await readFile(path.join(dir, "trace.log"))).subarray(observation.traceOffset).toString();
  await until(
    async () => / REPLY [0-9a-f]+\n\d+\.\d{9} CLOSE\n/.test(await tail()),
    "peer close after product exchange",
  );
  assert.ok(observedExchange(await tail()), "Rejected or missing product exchange");
  run("systemctl", "is-active", unit);
  return observation;
}

export async function recordGate(report, id, observe, save) {
  assert.equal(report[id].status, "NOT RUN");
  report[id] = { status: "INCOMPLETE" };
  await save();
  try {
    report[id] = { status: "PASS", observation: await observe() };
  } catch (error) {
    report[id] = { status: "FAIL", error: String(error.stack ?? error) };
    throw error;
  } finally {
    await save();
  }
}

async function main([id, directory]) {
  const dir = path.resolve(directory);
  const file = path.join(dir, "gates.json");
  if (id === "init") {
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        Object.fromEntries(Object.keys(gates).map((k) => [k, { status: "NOT RUN" }])),
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    await writeFile(path.join(dir, "trace.log"), "", { flag: "wx" });
    return;
  }
  const report = JSON.parse(await readFile(file, "utf8"));
  if (id === "result") {
    console.log(report);
    for (const gate of Object.keys(gates)) {
      assert.equal(
        report[gate].status,
        "PASS",
        `Hosted UHID reachability unproven: ${gate} ${report[gate].status}`,
      );
    }
    console.log("YES: the confined packaged app discovered and opened the hosted UHID peer.");
    return;
  }
  assert.ok(Object.hasOwn(gates, id));
  await recordGate(
    report,
    id,
    () => {
      assert.notEqual(process.getuid(), 0);
      return gates[id](dir, report);
    },
    async () => {
      await writeFile(file + ".tmp", JSON.stringify(report, null, 2) + "\n");
      await rename(file + ".tmp", file);
      await appendFile(path.join(dir, "progress.log"), id + " " + report[id].status + "\n");
    },
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main(process.argv.slice(2));
