import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";

export function windowsSystemTool(name, env = process.env) {
  const root = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  assert.ok(root && path.win32.isAbsolute(root), "Windows SystemRoot must be absolute");
  return path.win32.join(root, "System32", name);
}

export function parseWindowsProcessTable(stdout) {
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    assert.ok(
      row &&
        [row.pid, row.ppid].every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffff_ffff),
      "Malformed Windows process evidence",
    );
    assert.ok(row.created === null || (typeof row.created === "string" && row.created.length > 0));
    return row;
  });
}

const processTableScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ForEach-Object {
    [pscustomobject]@{
      pid = [uint32]$_.ProcessId
      ppid = [uint32]$_.ParentProcessId
      created = $(if ($null -ne $_.CreationDate) { ([datetime]$_.CreationDate).ToUniversalTime().ToString('o', [System.Globalization.CultureInfo]::InvariantCulture) } else { $null })
      executable = $_.ExecutablePath
      commandLine = $_.CommandLine
    }
  })
  ConvertTo-Json -InputObject $rows -Compress
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`;

export async function windowsProcessTable(run, env) {
  // execFile still crosses Windows command-line parsing. Encode the entire
  // script as UTF-16LE so $, quotes and pipeline operators stay PowerShell.
  // CIM exposes uint32 IDs and DateTime creation identities, not WMI strings.
  const { stdout } = await run(
    windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(processTableScript, "utf16le").toString("base64"),
    ],
    // Tooling timeout only (cold PowerShell + CIM enumeration on hosted runners);
    // it bounds the observer, not any product deadline.
    { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
  ).catch((error) => {
    // Public-run monitors retain String(error), so preserve diagnostics in
    // the message as well as structured fields. Never turn a failed query
    // into an empty table (which would falsely prove process cleanup).
    const detail = Object.fromEntries(
      ["code", "signal", "killed", "stdout", "stderr"].map((key) => [key, error[key]]),
    );
    throw Object.assign(
      new Error(`Windows process-table query failed: ${error.message}: ${JSON.stringify(detail)}`, {
        cause: error,
      }),
      detail,
    );
  });
  return parseWindowsProcessTable(stdout);
}

// One helper per observed lifecycle: pay PowerShell/CIM startup before launching
// the target, then request fresh snapshots over pipes. A failed query poisons
// the helper, so a late reply can never be mistaken for a later observation.
export async function createWindowsProcessObserver({
  start = spawn,
  env = process.env,
  startupTimeoutMs = 20_000,
  timeoutMs = 5000,
} = {}) {
  const query = processTableScript.replace(
    "ConvertTo-Json -InputObject $rows -Compress",
    "[Console]::WriteLine((ConvertTo-Json -InputObject $rows -Compress))",
  );
  const script = `while ($null -ne [Console]::ReadLine()) { ${query} }`;
  const child = start(
    windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let pending,
    failure,
    output = "",
    stderr = "";
  const fail = (error) => {
    failure ??= new Error(`Windows process observer failed: ${error.message}; stderr: ${stderr}`, {
      cause: error,
    });
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    child.kill();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code, signal) =>
    fail(new Error(`Helper exited: code=${code} signal=${signal}`)),
  );
  child.stdout.on("end", () => fail(new Error("Helper stdout closed")));
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-16_384);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (Buffer.byteLength(output) > 16 * 1024 * 1024) {
      fail(new Error("Process table exceeds buffer limit"));
      return;
    }
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    try {
      if (!pending || output.slice(newline + 1).trim())
        throw new Error("Unexpected process-table reply");
      const rows = parseWindowsProcessTable(output.slice(0, newline));
      output = output.slice(newline + 1);
      clearTimeout(pending.timer);
      pending.resolve(rows);
      pending = undefined;
    } catch (error) {
      fail(error);
    }
  });
  const request = (budget) => {
    if (failure) return Promise.reject(failure);
    // Coalesce concurrent readers; never queue queries behind a stuck query.
    if (pending) return pending.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    pending = {
      promise,
      resolve,
      reject,
      timer: setTimeout(() => fail(new Error("Process-table request timed out")), budget),
    };
    try {
      child.stdin.write("snapshot\n");
    } catch (error) {
      fail(error);
    }
    return promise;
  };
  await request(startupTimeoutMs);
  return {
    poll: () => request(timeoutMs),
    close: () => fail(new Error("Observer disposed")),
  };
}
