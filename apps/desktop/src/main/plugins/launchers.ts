import { MessageChannelMain, utilityProcess } from "electron";
import {
  escalatingKill,
  ExitSignal,
  OutputTail,
  PluginError,
  spawnPluginProcess,
  type LaunchablePlugin,
  type PluginLauncher,
  type PluginProcess,
} from "@kobrixa/plugin-runtime";
import type { PythonCommand } from "./python.js";

/** A utilityProcess that reports neither spawn nor exit must not hang the launch. */
export const PLUGIN_SPAWN_TIMEOUT_MS = 10_000;

async function launchNode(
  plugin: LaunchablePlugin,
  onOutput: (line: string) => void,
  spawnTimeoutMs: number,
): Promise<PluginProcess> {
  const child = utilityProcess.fork(plugin.entry, [], {
    cwd: plugin.directory,
    serviceName: `Kobrixa plugin ${plugin.id}`,
    stdio: "pipe",
  });
  const sigkill = () => {
    try {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
      else child.kill();
    } catch {
      /* The process already exited. */
    }
  };
  const tail = new OutputTail(onOutput);
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk, "stderr"));
  child.once("exit", () => tail.end());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sigkill();
      reject(new Error(`The plugin process did not start within ${spawnTimeoutMs} ms.`));
    }, spawnTimeoutMs);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The plugin process exited during launch (code ${code}).`));
    });
  });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: "kobrixa-plugin-port" }, [port2]);
  port1.start();
  const exits = new ExitSignal();
  child.once("exit", (code) => {
    port1.close();
    exits.emit({ code });
  });
  // utilityProcess.kill() sends SIGTERM on POSIX; escalate to SIGKILL when it is ignored.
  const kill = escalatingKill(exits, () => child.kill(), sigkill);
  return {
    send: (text) => port1.postMessage(text),
    onMessage: (listener) => {
      const handler = (event: Electron.MessageEvent) =>
        listener(typeof event.data === "string" ? event.data : "");
      port1.on("message", handler);
      return () => port1.off("message", handler);
    },
    onExit: (listener) => exits.subscribe(listener),
    ...kill,
    stderrTail: () => tail.text(),
  };
}

const logToConsole = (plugin: LaunchablePlugin, line: string) =>
  console.error(`[plugin ${plugin.id}] ${line}`);

export function createDesktopLauncher(options: {
  /** Read on every launch, so a newly chosen interpreter applies to the next plugin process. */
  python?: () => PythonCommand | undefined;
  spawnTimeoutMs?: number;
  onOutput?: (plugin: LaunchablePlugin, line: string) => void;
}): PluginLauncher {
  return async (plugin) => {
    const output = options.onOutput ?? logToConsole;
    const onOutput = (line: string) => output(plugin, line);
    if (plugin.runtime === "node")
      return launchNode(plugin, onOutput, options.spawnTimeoutMs ?? PLUGIN_SPAWN_TIMEOUT_MS);
    const python = options.python?.();
    if (!python)
      throw new PluginError(
        "PLUGIN_E_LAUNCH",
        "Choose a Python interpreter under Settings → Plugins → Developer mode, or start Kobrixa with --plugin-python=<interpreter>.",
      );
    return spawnPluginProcess(python.executable, [...python.args, "-u", plugin.entry], {
      onOutput,
      cwd: plugin.directory,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
  };
}
