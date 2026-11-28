import { hash } from "node:crypto";
import fs from "node:fs";

export function diagnosticSummary(bytes) {
  const data = Buffer.from(bytes);
  const classes = [
    ["primary-startup", /Primary startup failed/i],
    ["gpu-startup", /GPU process isn't usable/i],
    ["fatal", /FATAL:/i],
    ["crash", /SIGSEGV|SIGABRT|STATUS_ACCESS_VIOLATION/i],
  ];
  return {
    bytes: data.length,
    hash: hash("sha256", data),
    errors: classes.filter(([, re]) => re.test(data.toString())).map(([label]) => label),
  };
}
export function captureFile(file) {
  try {
    if (fs.lstatSync(file).isFile()) return fs.readFileSync(file);
  } catch {
    /* Missing or unreadable capture. */
  }
  return null;
}

// Only the paused main gets this per-launch nonce. The final sequence number
// also detects lost event records. Read the entire capture after process exit.
export function launchReceipt(capture, nonce, pid, expectedPid) {
  const prefix = "W17 " + nonce + " " + pid + " ";
  const records = (capture ?? "")
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  const started = Number.isInteger(pid) && pid > 0 && records[0] === "0 start";
  const final = records.at(-1) === records.length - 1 + " final";
  let valid = started && final;
  let launched = false,
    acknowledged = false,
    observedPid = null,
    exitCode = null,
    outcome = "no terminal observation";
  for (const [i, line] of records.slice(1, final ? -1 : undefined).entries()) {
    const [seq, event, target, code, ...extra] = line.split(" ");
    if (seq !== String(i + 1) || extra.length) valid = false;
    if (event === "clean-exit" && !target) continue;
    if (event === "utility-launch" && !target && !launched) {
      launched = true;
      continue;
    }
    if (
      event === "utility-spawn" &&
      !code &&
      launched &&
      !observedPid &&
      /^[1-9]\d*$/.test(target)
    ) {
      observedPid = Number(target);
      continue;
    }
    if (
      launched &&
      Number(target) === (observedPid ?? 0) &&
      outcome === "no terminal observation"
    ) {
      if (event === "utility-ack" && observedPid && !acknowledged && !code) {
        acknowledged = true;
        continue;
      }
      if (event === "utility-quit" || event === "utility-abnormal") {
        exitCode = /^-?\d+$/.test(code) ? Number(code) : null;
        outcome =
          event === "utility-quit" && acknowledged && exitCode === 0
            ? "expected quit"
            : "abnormal exit";
        continue;
      }
    }
    valid = false;
  }
  const utility =
    launched || expectedPid
      ? { pid: observedPid ?? expectedPid ?? null, acknowledged, exitCode, outcome }
      : null;
  return {
    started,
    healthy:
      !!valid &&
      (!utility || outcome === "expected quit") &&
      (!expectedPid || expectedPid === observedPid),
    records: records.length,
    utility,
  };
}

export function startupCapture(capture, nonce, pid, port) {
  // The inspector announcement is independent of our own lifecycle markers.
  // This port was reserved afresh and the capture handle was opened CREATE_NEW.
  return (
    launchReceipt(capture, nonce, pid).started &&
    capture
      .toString()
      .split(/\r?\n/)
      .some(
        (line) =>
          line.startsWith("Debugger listening on ws://127.0.0.1:" + port + "/") &&
          /\/[a-f0-9-]+$/i.test(line),
      )
  );
}

// This private checkpoint is made before asking the main process to fork the
// utility. Cleanup can recover complete marker lines even if the package step dies.
export function checkpointUtility(out, arm, file, nonce, pid) {
  const st = fs.lstatSync(file, { bigint: true });
  if (!st.isFile() || !st.ino || st.nlink !== 1n || !Number.isSafeInteger(pid) || pid <= 0)
    throw Error("Unverified utility capture");
  fs.appendFileSync(
    out + "/utility-captures.jsonl",
    JSON.stringify({ arm, file, nonce, pid, id: `${st.dev}/${st.ino}/${st.birthtimeNs}` }) + "\n",
    { mode: 0o600, flush: true },
  );
}

export function recoverUtilities(out, note) {
  const journal = out + "/utility-captures.jsonl";
  let launches;
  try {
    launches = fs.readFileSync(journal, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of launches.trimEnd().split("\n")) {
    const { arm, file, nonce, pid, id } = JSON.parse(line);
    let fd;
    try {
      const st = fs.lstatSync(file, { bigint: true });
      if (!st.isFile() || st.nlink !== 1n || `${st.dev}/${st.ino}/${st.birthtimeNs}` !== id)
        throw Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        `${opened.dev}/${opened.ino}/${opened.birthtimeNs}` !== id
      )
        throw Error();
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      note("utility capture refused", { arm, pid });
      continue;
    }
    let bytes;
    try {
      bytes = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const prefix = "W17 " + nonce + " " + pid + " ";
    for (const text of bytes.split(/\r?\n/).slice(0, -1)) {
      if (!text.startsWith(prefix)) continue;
      const marker =
        /^(\d+) utility-(launch|spawn|ack|quit|abnormal|missing)(?: (\d+))?(?: (-?\d+|unknown))?$/.exec(
          text.slice(prefix.length),
        );
      if (!marker) continue;
      const [, , event, target, code] = marker;
      const terminal = event === "quit" || event === "abnormal";
      if ((event === "launch") !== (target === undefined) || terminal !== (code !== undefined))
        continue;
      note("utility lifecycle", {
        arm,
        mainPid: pid,
        sequence: Number(marker[1]),
        event: marker[2],
        pid: marker[3] ? Number(marker[3]) : null,
        exitCode: marker[4] && marker[4] !== "unknown" ? Number(marker[4]) : null,
      });
    }
  }
}
