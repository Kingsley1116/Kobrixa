import assert from "node:assert/strict";
import path from "node:path";

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

export async function windowsProcessTable(run, env) {
  // execFile still crosses Windows command-line parsing. Encode the entire
  // script as UTF-16LE so $, quotes and pipeline operators stay PowerShell.
  // CIM exposes uint32 IDs and DateTime creation identities, not WMI strings.
  const script = `
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
  const { stdout } = await run(
    windowsSystemTool("WindowsPowerShell/v1.0/powershell.exe", env),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
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
