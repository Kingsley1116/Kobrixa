import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { MessageChannelMain, utilityProcess } from "electron";
import { spawnPluginProcess, type LaunchablePlugin } from "@kobrixa/plugin-runtime";
import type * as PluginRuntime from "@kobrixa/plugin-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createDesktopLauncher } from "./launchers.js";

vi.mock("electron", () => ({
  utilityProcess: { fork: vi.fn() },
  MessageChannelMain: vi.fn(function () {
    return {
      port1: { start: vi.fn(), close: vi.fn(), postMessage: vi.fn() },
      port2: {},
    };
  }),
}));
vi.mock("@kobrixa/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginRuntime>()),
  spawnPluginProcess: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const plugin: LaunchablePlugin = {
  id: "acme.logs",
  directory: "/plugins/logs",
  entry: "/plugins/logs/main.cjs",
  runtime: "node",
  permissions: [],
  commands: [],
};

it("forwards separate utilityProcess output streams to the main console and flushes on exit", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    postMessage: vi.fn(),
    kill: vi.fn(),
  });
  vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as Electron.UtilityProcess);
  const launched = createDesktopLauncher({})(plugin);
  child.emit("spawn");
  const process = await launched;

  const text = Buffer.from("世界\nsecond\npartial");
  child.stdout.write(text.subarray(0, 1));
  child.stderr.write("error\nlast error");
  child.stdout.write(text.subarray(1));
  expect(log.mock.calls).toEqual([
    ["[plugin acme.logs] error"],
    ["[plugin acme.logs] 世界"],
    ["[plugin acme.logs] second"],
  ]);
  expect(process.stderrTail()).not.toContain("�");
  expect(process.stderrTail()).toContain("世界\nsecond\npartial");

  const onExit = vi.fn(() => {
    expect(log).toHaveBeenCalledWith("[plugin acme.logs] partial");
    expect(log).toHaveBeenCalledWith("[plugin acme.logs] last error");
  });
  process.onExit(onExit);
  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  child.stdout.end();
  child.stderr.end();
  await Promise.all([stdoutEnded, stderrEnded]);
  child.emit("exit", 0);
  expect(onExit).toHaveBeenCalledExactlyOnceWith({ code: 0 });
  expect(log).toHaveBeenCalledTimes(5);
  expect(
    vi.mocked(MessageChannelMain).mock.results.at(-1)?.value.port1.close,
  ).toHaveBeenCalledOnce();
});

it("wires Python stderr lines to the same prefixed main console", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await createDesktopLauncher({ python: () => ({ executable: "/python", args: [] }) })({
    ...plugin,
    runtime: "python",
  });
  const [command, args, options] = vi.mocked(spawnPluginProcess).mock.calls.at(-1)!;
  expect(command).toBe("/python");
  expect(args).toEqual(["-u", plugin.entry]);
  expect(options.cwd).toBe(plugin.directory);
  expect(options.onOutput).toEqual(expect.any(Function));
  options.onOutput?.("世界");
  expect(log).toHaveBeenCalledExactlyOnceWith("[plugin acme.logs] 世界");
});

it("kills a utilityProcess that never reports spawn and fails the launch", async () => {
  vi.useFakeTimers();
  try {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      postMessage: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
    });
    vi.mocked(utilityProcess.fork).mockReturnValue(child as unknown as Electron.UtilityProcess);
    const launched = createDesktopLauncher({ spawnTimeoutMs: 50 })(plugin);
    const failed = expect(launched).rejects.toThrow("did not start within 50 ms");
    await vi.advanceTimersByTimeAsync(50);
    await failed;
    expect(child.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("reads the Python command on every launch and puts its arguments first", async () => {
  let python = { executable: "py", args: ["-3"] };
  const launch = createDesktopLauncher({ python: () => python });
  await launch({ ...plugin, runtime: "python" });
  expect(vi.mocked(spawnPluginProcess).mock.calls.at(-1)!.slice(0, 2)).toEqual([
    "py",
    ["-3", "-u", plugin.entry],
  ]);
  python = { executable: "/new/python", args: [] };
  await launch({ ...plugin, runtime: "python" });
  expect(vi.mocked(spawnPluginProcess).mock.calls.at(-1)![0]).toBe("/new/python");
});

it("refuses a Python plugin when no interpreter is chosen", async () => {
  await expect(
    createDesktopLauncher({ python: () => undefined })({ ...plugin, runtime: "python" }),
  ).rejects.toMatchObject({ code: "PLUGIN_E_LAUNCH" });
});

it("sends output lines to the output hook together with the plugin", async () => {
  const onOutput = vi.fn();
  await createDesktopLauncher({ python: () => ({ executable: "/python", args: [] }), onOutput })({
    ...plugin,
    sourceKey: "dev:0123456789abcdef",
    runtime: "python",
  });
  vi.mocked(spawnPluginProcess).mock.calls.at(-1)![2].onOutput?.("hi");
  expect(onOutput).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKey: "dev:0123456789abcdef" }),
    "hi",
  );
});
