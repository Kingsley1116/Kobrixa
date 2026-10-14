import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { encodeContentLength } from "@kobrixa/plugin-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputTail, spawnPluginProcess, stdioProcess, type ProcessExit } from "./index.js";

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
    const onOutput = vi.fn();
    const child = await spawnPluginProcess(process.execPath, ["-e", echo], {
      cwd: process.cwd(),
      onOutput,
    });
    const received = new Promise<string>((resolve) => child.onMessage(resolve));
    child.send('{"hello":"世界"}');
    expect(await received).toBe('{"hello":"世界"}');
    await vi.waitFor(() => expect(child.stderrTail()).toContain("log line"));
    expect(onOutput).toHaveBeenCalledExactlyOnceWith("log line");
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
  it("preserves final stderr in the exit listener after an immediate exit", async () => {
    const child = await node(`process.stderr.write("last words\\n"); process.exit(3);`);
    const result = await new Promise<{ exit: ProcessExit; tail: string }>((resolve) =>
      child.onExit((exit) => resolve({ exit, tail: child.stderrTail() })),
    );
    expect(result.exit.code).toBe(3);
    expect(result.tail).toContain("last words");
  });
  it("preserves the non-protocol stdout reason after an immediate exit", async () => {
    const child = await node(`process.stdout.write("debug\\n"); process.exit(0);`);
    const exit = await new Promise<ProcessExit>((resolve) => child.onExit(resolve));
    expect(exit.reason).toMatch(/non-protocol data to stdout/);
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

const controlledChild = (pid?: number, options: Parameters<typeof stdioProcess>[1] = {}) => {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const plugin = stdioProcess(child as unknown as ChildProcessWithoutNullStreams, options);
  return { child, plugin };
};

const endOutput = async (stream: PassThrough) => {
  const ended = once(stream, "end");
  stream.end();
  await ended;
};

describe("stdio process event ordering", () => {
  afterEach(() => vi.useRealTimers());

  it("decodes split UTF-8 output into complete lines and flushes the last line on exit", async () => {
    const onOutput = vi.fn();
    const { child, plugin } = controlledChild(123, { onOutput });
    const text = Buffer.from("世界\nsecond\r\n\nlast 世界");
    child.stderr.write(text.subarray(0, 1));
    expect(onOutput).not.toHaveBeenCalled();
    expect(plugin.stderrTail()).toBe("");
    child.stderr.write(text.subarray(1, 5));
    expect(onOutput).not.toHaveBeenCalled();
    child.stderr.write(text.subarray(5));
    child.stdout.write(encodeContentLength("{}"));
    expect(onOutput.mock.calls).toEqual([["世界"], ["second"], [""]]);
    expect(plugin.stderrTail()).toBe(text.toString());

    const onExit = vi.fn(() => expect(onOutput).toHaveBeenLastCalledWith("last 世界"));
    plugin.onExit(onExit);
    child.emit("exit", 0, null);
    await endOutput(child.stdout);
    await endOutput(child.stderr);
    expect(onOutput.mock.calls).toEqual([["世界"], ["second"], [""], ["last 世界"]]);
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("decodes split UTF-8 in the bounded tail even without an output hook", () => {
    const tail = new OutputTail();
    tail.push("x".repeat(20_000));
    const text = Buffer.from("世界");
    tail.push(text.subarray(0, 2));
    tail.push(text.subarray(2, 5));
    tail.push(text.subarray(5));
    expect(tail.text()).toHaveLength(16 * 1024);
    expect(tail.text().slice(-2)).toBe("世界");
    expect(tail.text()).not.toContain("�");
  });

  it.each(["stdout", "stderr"] as const)(
    "waits for both output streams when %s ends first",
    async (first) => {
      vi.useFakeTimers();
      const { child, plugin } = controlledChild(123);
      const listener = vi.fn((exit: ProcessExit) => ({ exit, tail: plugin.stderrTail() }));
      plugin.onExit(listener);

      child.emit("exit", 0, null);
      expect(listener).not.toHaveBeenCalled();
      child.stderr.write("last words\n");
      child.stdout.write("debug\n");
      await endOutput(child[first]);
      expect(listener).not.toHaveBeenCalled();
      await endOutput(child[first === "stdout" ? "stderr" : "stdout"]);

      expect(listener).toHaveBeenCalledExactlyOnceWith({
        code: 0,
        reason:
          "Plugin wrote non-protocol data to stdout (Malformed message header.). Write logs to stderr.",
      });
      expect(listener.mock.results[0]?.value.tail).toBe("last words\n");
      expect(vi.getTimerCount()).toBe(0);
      expect(child.stdout.listenerCount("end")).toBe(0);
      expect(child.stderr.listenerCount("end")).toBe(0);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "waits for the remaining stream when %s already ended before exit",
    async (first) => {
      vi.useFakeTimers();
      const { child, plugin } = controlledChild(123);
      const listener = vi.fn();
      plugin.onExit(listener);
      await endOutput(child[first]);

      child.emit("exit", 3, null);
      expect(listener).not.toHaveBeenCalled();
      await endOutput(child[first === "stdout" ? "stderr" : "stdout"]);
      expect(listener).toHaveBeenCalledExactlyOnceWith({ code: 3 });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("reports exit immediately if both output streams already ended", async () => {
    vi.useFakeTimers();
    const { child, plugin } = controlledChild(123);
    const listener = vi.fn();
    plugin.onExit(listener);
    await endOutput(child.stdout);
    await endOutput(child.stderr);

    child.emit("exit", 3, null);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ code: 3 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the output drain wait at 100 ms without waiting for close", async () => {
    vi.useFakeTimers();
    const onOutput = vi.fn();
    const { child, plugin } = controlledChild(123, { onOutput });
    const listener = vi.fn();
    plugin.onExit(listener);
    child.stderr.write("partial");

    child.emit("exit", null, "SIGTERM");
    vi.advanceTimersByTime(99);
    expect(listener).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      code: null,
      reason: "terminated by SIGTERM",
    });
    expect(onOutput).toHaveBeenCalledExactlyOnceWith("partial");
    expect(child.stdout.listenerCount("end")).toBe(0);
    expect(child.stderr.listenerCount("end")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await endOutput(child.stdout);
    await endOutput(child.stderr);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledTimes(1);
  });

  it("does not classify a throwing message listener as a framing error", async () => {
    vi.useFakeTimers();
    const { child, plugin } = controlledChild(123);
    const failure = new Error("message listener failed");
    const unsubscribe = plugin.onMessage(() => {
      throw failure;
    });
    expect(() => child.stdout.emit("data", encodeContentLength("{}"))).toThrow(failure);
    expect(child.kill).not.toHaveBeenCalled();
    unsubscribe();

    const received = vi.fn();
    plugin.onMessage(received);
    child.stdout.emit("data", encodeContentLength("{}"));
    expect(received).toHaveBeenCalledExactlyOnceWith("{}");
    const listener = vi.fn();
    plugin.onExit(listener);
    child.emit("exit", 0, null);
    await endOutput(child.stdout);
    await endOutput(child.stderr);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  });

  it("reports a startup error once and handles subsequent errors", () => {
    const { child, plugin } = controlledChild();
    const listener = vi.fn();
    plugin.onExit(listener);

    child.emit("error", new Error("spawn failed"));
    expect(listener).toHaveBeenCalledExactlyOnceWith({ code: null, reason: "spawn failed" });
    expect(() => child.emit("error", new Error("second error"))).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each(["before spawn", "after spawn"] as const)(
    "keeps handling errors without reporting an exit when wrapped %s",
    async (when) => {
      vi.useFakeTimers();
      const { child, plugin } = controlledChild(when === "after spawn" ? 123 : undefined);
      const listener = vi.fn();
      plugin.onExit(listener);
      if (when === "before spawn") child.emit("spawn");

      child.emit("error", new Error("kill failed"));
      expect(listener).not.toHaveBeenCalled();
      expect(() => child.emit("error", new Error("second error"))).not.toThrow();
      plugin.kill();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      vi.advanceTimersByTime(2000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      child.emit("exit", null, "SIGKILL");
      await endOutput(child.stdout);
      await endOutput(child.stderr);
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        code: null,
        reason: "terminated by SIGKILL",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
