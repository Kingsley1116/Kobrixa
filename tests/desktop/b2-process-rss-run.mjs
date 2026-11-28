import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, realpath, readFile, mkdir, mkdtemp, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildFoundationRenderer } from "./plugin-persistence-renderer-build.mjs";
import { runFoundationEvidence } from "./plugin-persistence-run.mjs";
import { checkpointReport } from "./b2-process-rss-checkpoints.mjs";
import { approvedRecord, deriveTrial, partialCadence, trials } from "./b2-process-rss-verify.mjs";

function command(file, ...args) {
  return execFileSync(file, args, { encoding: "utf8", timeout: 30000 }).trim();
}
async function hostInventory() {
  // Resolve the device backing the profile and originals, both in os.tmpdir().
  const volume = os.tmpdir(),
    stat = await statfs(volume);
  let filesystem,
    power,
    disk,
    localSSD = false;
  if (process.platform === "darwin") {
    const device = command("df", "-P", volume).split("\n").at(-1).split(/\s+/)[0];
    filesystem = command("diskutil", "info", device);
    const physical =
      /APFS Physical Store:\s*(disk\d+)s\d+/.exec(filesystem)?.[1] ??
      /Part of Whole:\s*(disk\d+)/.exec(filesystem)?.[1];
    assert.ok(physical, "missing backing disk");
    disk = command("diskutil", "info", physical);
    localSSD = /Solid State:\s*Yes/i.test(disk) && !/Virtual:\s*Yes/i.test(disk);
    power = command("pmset", "-g") + "\n" + command("pmset", "-g", "batt");
  } else if (process.platform === "linux") {
    filesystem = command("findmnt", "-T", volume, "-n", "-o", "FSTYPE,SOURCE,TARGET");
    const device = command("findmnt", "-T", volume, "-n", "-o", "SOURCE").split("[")[0];
    disk = command("lsblk", "-s", "-J", "-o", "NAME,TYPE,ROTA,MODEL,TRAN", device);
    const devices = JSON.parse(disk).blockdevices;
    const physical = devices
      .flatMap(function flatten(d) {
        return [d, ...(d.children ?? []).flatMap(flatten)];
      })
      .filter((d) => d.type === "disk");
    localSSD =
      physical.length > 0 &&
      physical.every(
        (d) =>
          d.rota === false &&
          d.model?.trim() &&
          !/virtual|elastic block store|network/i.test(d.model),
      );
    power = await readFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "utf8").then(
      (s) => s.trim(),
      () => null,
    );
  } else if (process.platform === "win32") {
    const drive = path.parse(volume).root[0];
    assert.match(drive, /^[a-z]$/i);
    const ps = (script) =>
      command("powershell", "-NoProfile", "-NonInteractive", "-Command", script);
    filesystem = ps(
      `Get-Volume -DriveLetter ${drive} | Select FileSystem,DriveType,Path | ConvertTo-Json -Compress`,
    );
    disk = ps(
      `$d=Get-Partition -DriveLetter ${drive} | Get-Disk; Get-PhysicalDisk | Where-Object DeviceId -eq $d.Number | Select FriendlyName,@{Name='MediaType';Expression={[string]$_.MediaType}},@{Name='BusType';Expression={[string]$_.BusType}} | ConvertTo-Json -Compress`,
    );
    const physical = JSON.parse(disk || "null");
    localSSD =
      physical?.MediaType === "SSD" &&
      !!physical.FriendlyName &&
      !/virtual|iscsi/i.test(physical.BusType);
    power = command("powercfg", "/GETACTIVESCHEME");
  } else throw Error("Unsupported B2 platform");
  const idle = () =>
    os.cpus().reduce(
      (a, c) => ({
        idle: a.idle + c.times.idle,
        total: a.total + Object.values(c.times).reduce((s, n) => s + n, 0),
      }),
      { idle: 0, total: 0 },
    );
  const before = idle();
  await delay(1000);
  const after = idle();
  return {
    hostname: os.hostname(),
    release: os.release(),
    os: os.version() + " " + os.release(),
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    ram: os.totalmem(),
    volume,
    filesystem,
    freeBytes: stat.bavail * stat.bsize,
    power,
    disk,
    localSSD,
    background: {
      loadAverage: os.loadavg(),
      idleFraction: (after.idle - before.idle) / (after.total - before.total),
    },
  };
}
const approval = await approvedRecord();
const output = await realpath(await mkdtemp(path.join(os.tmpdir(), "kobrixa-b2-rss-")));
console.log("B2 RSS artifacts:", output);
const { receipt: rendererReceipt, artifact: renderer } = await buildFoundationRenderer(
  path.join(await mkdtemp(path.join(os.tmpdir(), "b2-renderer-")), "build"),
);
for (const { workload, folder } of trials) {
  const directory = path.join(output, folder);
  await mkdir(directory);
  const save = (name, value) =>
    writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { flag: "wx" });
  await save("approval.json", approval);
  let result;
  try {
    const host = await hostInventory();
    await runFoundationEvidence({
      caseId: workload,
      evidencePath: path.join(directory, "workload.json"),
      rssTrial: { directory, host, rendererReceipt, renderer },
    });
    result = await deriveTrial(directory, workload);
  } catch (error) {
    const started = await access(path.join(directory, "identity.json")).then(
      () => true,
      (e) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    );
    result = { status: started ? "INVALID" : "NOT RUN", workload, reason: error.stack };
    // Preserve a measured over-cap result even when subsequent workload validation fails.
    try {
      result = { ...(await deriveTrial(directory, workload)), producerError: error.stack };
      if (result.status !== "FAIL") result.status = "INVALID";
    } catch {
      try {
        const cadence = await partialCadence(directory);
        if (cadence) result.partialCadence = cadence;
      } catch (readError) {
        result.cadenceReadError = readError.message;
      }
    }
  }
  await save("receipt.json", result);
  // Optional attribution has no input to deriveTrial or the independent verifier.
  try {
    const report = await checkpointReport(directory, workload);
    await save("rss-attribution.json", report);
    const peak = report.checkpoints.find((point) => point.label === "peak");
    console.log(folder, "sampled peak attribution", {
      bytes: report.peak?.bytes,
      mainDeltaBytes: peak.main?.memoryDeltaBytes,
      workerDeltaBytes: peak.persistence?.memoryDeltaBytes,
      processes: peak.main?.processes,
      detail: path.join(directory, "rss-attribution.json"),
    });
  } catch (error) {
    console.error(folder, "attribution unavailable", error);
  }
  console.log(folder, result.status, result.reason ?? result.problems);
}
const verifier = spawnSync(
  process.execPath,
  [
    "--experimental-transform-types",
    "--import",
    "./tests/desktop/persistence-source-loader.mjs",
    "tests/desktop/b2-process-rss-verify.mjs",
    output,
  ],
  { stdio: "inherit" },
);
assert.ifError(verifier.error);
assert.equal(verifier.status, 0, "Independent B2 RSS validation failed");
