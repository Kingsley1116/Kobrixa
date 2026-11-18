import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const source = fileURLToPath(new URL("fixtures/ev3-uhid/peer.c", import.meta.url));
const unit = "kobrixa-uhid-spike.service";
const gates = { G1, G2 };

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
        `UHID peer provisioning incomplete: ${gate} ${report[gate].status}`,
      );
    }
    console.log("UHID peer provisioned.");
    return;
  }
  assert.ok(Object.hasOwn(gates, id));
  await recordGate(
    report,
    id,
    () => {
      assert.notEqual(process.getuid(), 0);
      return gates[id](dir);
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
