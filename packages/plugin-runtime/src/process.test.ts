import { describe, expect, it, vi } from "vitest";
import { spawnPluginProcess } from "./index.js";

const node = (script: string) =>
  spawnPluginProcess(process.execPath, ["-e", script], { cwd: process.cwd() });
const echo = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  const end = buffer.indexOf("\\r\\n\\r\\n");
  if (end < 0) return;
  const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, end).toString())[1]);
  const body = buffer.subarray(end + 4, end + 4 + length);
  if (body.length < length) return;
  process.stderr.write("log line\\n");
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
});`;

describe("stdio plugin process", () => {
  it("exchanges framed messages and keeps stderr as logs", async () => {
    const child = await node(echo);
    const received = new Promise<string>((resolve) => child.onMessage(resolve));
    child.send('{"hello":"世界"}');
    expect(await received).toBe('{"hello":"世界"}');
    expect(child.stderrTail()).toContain("log line");
    const exited = new Promise((resolve) => child.onExit(resolve));
    child.kill();
    await exited;
  });
  it("stops a plugin that prints to stdout and explains why", async () => {
    const child = await node(`console.log("debug"); setInterval(() => {}, 1000);`);
    const exit = await new Promise<{ reason?: string }>((resolve) => child.onExit(resolve));
    expect(exit.reason).toMatch(/non-protocol data to stdout/);
  });
  it("reports late exit subscribers immediately", async () => {
    const child = await node("process.exit(3)");
    await new Promise((resolve) => child.onExit(resolve));
    await expect(new Promise((resolve) => child.onExit(resolve))).resolves.toMatchObject({
      code: 3,
    });
  });
  it("rejects when the interpreter cannot be started", async () => {
    await expect(
      spawnPluginProcess("kobrixa-no-such-python", [], { cwd: process.cwd() }),
    ).rejects.toThrow(/ENOENT|not found/i);
  });
  it("escalates to a forced kill when the plugin ignores SIGTERM", async () => {
    const child = await spawnPluginProcess(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => {}); process.stderr.write("ready\\n"); setInterval(() => {}, 1000);`,
      ],
      { cwd: process.cwd(), killGraceMs: 200 },
    );
    await vi.waitFor(() => expect(child.stderrTail()).toContain("ready"));
    const started = Date.now();
    const exit = new Promise<{ reason?: string }>((resolve) => child.onExit(resolve));
    child.kill();
    child.kill(); // Repeated requests must not postpone the forced kill.
    const result = await exit;
    expect(Date.now() - started).toBeLessThan(2000);
    // Windows has no SIGTERM handlers: kill() terminates immediately there.
    if (process.platform !== "win32") expect(result.reason).toBe("terminated by SIGKILL");
  });
  it("force-kills immediately without waiting for the grace period", async () => {
    const child = await spawnPluginProcess(
      process.execPath,
      [
        "-e",
        `process.on("SIGTERM", () => {}); process.stderr.write("ready\\n"); setInterval(() => {}, 1000);`,
      ],
      { cwd: process.cwd(), killGraceMs: 60_000 },
    );
    await vi.waitFor(() => expect(child.stderrTail()).toContain("ready"));
    const started = Date.now();
    const exit = new Promise((resolve) => child.onExit(resolve));
    child.kill();
    child.forceKill();
    await exit;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
