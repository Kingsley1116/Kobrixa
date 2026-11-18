// The audit daemon and rule live on the host. Only this controller enters its
// network namespace to talk to the kernel audit socket. Product launches always
// retain the networkless namespace, original UID, AppArmor and Landlock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { machine, release } from "node:os";

const exec = promisify(execFile);
export async function observeProfileWrites(profile, directory, key, observe, missing) {
  const host = async (file, ...args) =>
    (
      await exec(
        "/usr/bin/sudo",
        ["-n", "/usr/bin/nsenter", "--net=/proc/1/ns/net", "--", file, ...args],
        { timeout: 30000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      )
    ).stdout;
  const ctl = (...args) => host("/usr/sbin/auditctl", ...args);
  // Watch successful write/attribute access to files in this one profile.
  const filter = (abi) => [
    "-F",
    "arch=" + abi,
    "-S",
    "all",
    "-F",
    "dir=" + profile,
    "-F",
    "perm=wa",
    "-F",
    "success=1",
    "-k",
    key,
  ];
  const installed = [],
    attempts = {};
  // Linux x32 shares the x86_64 audit arch, but has tagged syscall
  // numbers. A listed b64 permission rule alone proves no x32 coverage.
  // Query getpid with the x32 bit. ENOSYS from an unfiltered process on
  // the runner is evidence that this kernel has disabled the x32 table.
  const probe = `import ctypes, json, os
libc = ctypes.CDLL(None, use_errno=True)
native = libc.syscall(39)
result = libc.syscall(0x40000000 | 39)
print(json.dumps(dict(pid=os.getpid(), native=native, result=result,
    errno=ctypes.get_errno(), seccomp=next(s.strip() for s in open('/proc/self/status') if s.startswith('Seccomp:')))))`;
  const kernel = { machine: machine(), release: release() };
  let before, rulesBefore;
  try {
    try {
      before = await ctl("-s");
      for (const abi of ["b64", "b32", "x32"]) {
        try {
          await ctl("-a", "always,exit", ...filter(abi));
          installed.push(abi);
          attempts[abi] = { installed: true };
        } catch (error) {
          attempts[abi] = { installed: false, error: error.message };
        }
      }
      if (kernel.machine === "x86_64" && !attempts.x32.installed)
        kernel.x32Getpid = JSON.parse((await exec("/usr/bin/python3", ["-c", probe])).stdout);
      if (!attempts.b32.installed) {
        const config = await host("/bin/cat", "/boot/config-" + kernel.release);
        kernel.ia32Config = config
          .split("\n")
          .find(
            (s) => s.includes("CONFIG_IA32_EMULATION ") || s.startsWith("CONFIG_IA32_EMULATION="),
          );
      }
      rulesBefore = await ctl("-l");
      checkAbiCoverage({ kernel, attempts, rules: rulesBefore }, profile, key);
    } catch (error) {
      missing("profile write attribution unresolved — " + error.message);
    }
    try {
      await observe();
    } finally {
      try {
        const rules = await ctl("-l");
        const after = await ctl("-s");
        // auditd can still be assembling a multipart event when the app exits.
        // The installed controller already waited five seconds after both trees.
        const raw = await host("/usr/sbin/ausearch", "--raw", "-k", key);
        await writeFile(path.join(directory, "profile-audit.log"), raw, { flag: "wx" });
        await writeFile(
          path.join(directory, "profile-audit.json"),
          JSON.stringify({
            key,
            profile,
            sha256: createHash("sha256").update(raw).digest("hex"),
            kernel,
            attempts,
            rulesBefore: rulesBefore
              ?.split("\n")
              .filter((s) => s.includes(key))
              .join("\n"),
            attribution: PROFILE_ATTRIBUTION,
            before,
            after,
            rules: rules
              .split("\n")
              .filter((s) => s.includes(key))
              .join("\n"),
          }),
          { flag: "wx" },
        );
      } catch (error) {
        missing("kernel profile audit evidence — " + error.message);
      }
    }
  } finally {
    for (const abi of installed.reverse()) {
      try {
        await ctl("-d", "always,exit", ...filter(abi));
      } catch (error) {
        missing("profile audit rule cleanup " + abi + " — " + error.message);
      }
    }
  }
}

export const PROFILE_ATTRIBUTION =
  "Linux SYSCALL pid is the thread-group ID. Writes by primary worker threads are attributed to the primary process.";

function checkAbiCoverage({ kernel, attempts, rules }, profile, key) {
  assert.equal(kernel.machine, "x86_64", "audit ABI inventory requires the x86-64 runner");
  const covered = [];
  for (const abi of ["b64", "b32", "x32"]) {
    const attempt = attempts[abi];
    if (attempt?.installed === false && attempt.error) {
      if (abi === "b32" && kernel.ia32Config === "# CONFIG_IA32_EMULATION is not set") continue;
      const probe = kernel.x32Getpid;
      if (
        abi === "x32" &&
        probe?.pid > 0 &&
        probe.native === probe.pid &&
        probe.result === -1 &&
        probe.errno === 38 &&
        /^Seccomp:\s+0$/.test(probe.seccomp)
      )
        continue;
    }
    assert.equal(attempt?.installed, true, "unresolved profile write attribution for " + abi);
    assert.ok(
      rules.split("\n").some((line) => {
        // Accept auditctl's canonical listing, including its optional -S all.
        const tokens = line
          .replace(" -S all", "")
          .replace(" -F key=", " -k ")
          .replace(" -F success=yes", " -F success=1")
          .trim()
          .split(/\s+/);
        const fields = [];
        for (let i = 0; i < tokens.length; i += 2) fields.push(tokens[i] + " " + tokens[i + 1]);
        return isDeepStrictEqual(
          fields.sort(),
          [
            "-a always,exit",
            "-F arch=" + abi,
            "-F dir=" + profile,
            "-F perm=wa",
            "-F success=1",
            "-k " + key,
          ].sort(),
        );
      }),
      "missing kernel profile audit rule for " + abi,
    );
    covered.push(abi);
  }
  return covered;
}

// ausearch -k selects whole events. Parse the kernel fields before auditd's
// optional enrichment separator and join records by timestamp AND serial.
function auditEvents(raw) {
  const events = new Map();
  for (const line of raw.split("\n")) {
    if (!/^type=(SYSCALL|CONFIG_CHANGE|SOCKADDR|PATH)\b/.test(line)) continue;
    const kernelRecord = line.split("\x1d", 1)[0];
    const header = /^type=(\w+) msg=audit\(((\d+\.\d+):\d+)\):? /.exec(kernelRecord);
    assert.ok(header, "timestamped kernel audit event");
    const [, type, id, stamp] = header;
    if (!events.has(id)) events.set(id, { id, at: Number(stamp) * 1000, records: [] });
    const fields = new Map();
    for (const [, name, value] of kernelRecord.matchAll(/ (\w+)=("[^"]*"|[^ ]+)/g)) {
      assert.ok(!fields.has(name), "duplicate kernel audit field " + name);
      fields.set(name, value);
    }
    events.get(id).records.push({ type, fields });
  }
  return events.values();
}

function hasAuditKey(fields, key) {
  return fields.get("key") === '"' + key + '"' || fields.get("key") === key;
}

function isRuleManagement(records, syscall, key) {
  const changes = records.filter((r) => r.type === "CONFIG_CHANGE");
  if (changes.length !== 1) return false;
  const change = changes[0].fields;
  const destinations = records.filter((r) => r.type === "SOCKADDR");
  // The kernel logs a successful rule change in the sending syscall's
  // audit context while processing its audit netlink message. That join
  // also identifies the socket when the first rule has no SOCKADDR record.
  return (
    hasAuditKey(change, key) &&
    ["add_rule", "remove_rule"].includes(change.get("op")) &&
    change.get("list") === "4" &&
    change.get("res") === "1" &&
    records.filter((r) => r.type === "SYSCALL").length === 1 &&
    !records.some((r) => r.type === "PATH") &&
    destinations.length <= 1 &&
    (!destinations.length || destinations[0].fields.get("saddr") === "100000000000000000000000") &&
    syscall.get("key") === "(null)" &&
    syscall.get("comm") === '"auditctl"' &&
    syscall.get("exe") === '"/usr/sbin/auditctl"' &&
    syscall.get("uid") === "0" &&
    syscall.get("euid") === "0" &&
    syscall.get("arch") === "c000003e" &&
    syscall.get("syscall") === "44" &&
    syscall.get("items") === "0"
  );
}

export function verifyProfileWrites(
  state,
  raw,
  profile,
  key,
  primary,
  secondary,
  { low, high },
  bracket,
) {
  assert.equal(state.key, key);
  assert.equal(state.profile, profile);
  assert.equal(state.attribution, PROFILE_ATTRIBUTION);
  checkAbiCoverage({ ...state, rules: state.rulesBefore }, profile, key);
  const coveredAbis = checkAbiCoverage(state, profile, key);
  for (const status of [state.before, state.after]) {
    assert.match(status, /^enabled [12]$/m);
    assert.match(status, /^pid [1-9]\d*$/m);
    assert.match(status, /^lost 0$/m);
  }
  // Include every millisecond bucket that could intersect spawn through exit.
  const start = secondary.beforeSpawn + low - 1,
    end = secondary.exit.monotonic + high + 1;
  assert.ok(
    secondary.startedAt >= start &&
      secondary.startedAt <= secondary.observation.installedMonotonic + high + 1,
    "spawn wall time disagrees with launch clock",
  );
  assert.ok(
    secondary.exit.at >= secondary.exit.monotonic + low - 1 && secondary.exit.at <= end,
    "exit wall time disagrees with launch clock",
  );
  const observationStart = Math.min(start, bracket.start + bracket.clock.low - 1);
  const observationEnd = Math.max(end, bracket.end + bracket.clock.high + 1);
  const primaryTimes = [];
  for (const { id, at, records } of auditEvents(raw)) {
    for (const { type, fields } of records) {
      if (type !== "SYSCALL") continue;
      assert.equal(fields.get("success"), "yes");
      assert.match(fields.get("pid"), /^\d+$/);
      assert.match(fields.get("ppid"), /^\d+$/);
      const pid = Number(fields.get("pid")),
        parent = Number(fields.get("ppid"));
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(parent));
      assert.ok(
        !secondary.observedPids.includes(pid) && !secondary.observedPids.includes(parent),
        `secondary profile write in audit(${id}) pid=${pid} ppid=${parent}`,
      );
      if (!hasAuditKey(fields, key)) {
        assert.ok(isRuleManagement(records, fields, key), "audit rule attribution");
        continue;
      }
      if (at >= observationStart && at <= observationEnd)
        assert.ok(
          pid === primary || parent === primary,
          "unattributed profile write during launch",
        );
      if (pid === primary) primaryTimes.push(at);
    }
  }
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    state.sha256,
    "profile audit digest",
  );
  assert.ok(
    primaryTimes.some((at) => at < observationStart) &&
      primaryTimes.some((at) => at > observationEnd),
    "primary profile writes bracket complete exchanges and secondary lifetime",
  );
  return { coveredAbis, attribution: state.attribution };
}
