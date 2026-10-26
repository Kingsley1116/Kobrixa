import { resourceOwnerSchema } from "@kobrixa/plugin-protocol";
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

function channelEnvironment(plugin: LaunchablePlugin): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KOBRIXA_RESOURCE_OWNER;
  if (plugin.channelOwner)
    env.KOBRIXA_RESOURCE_OWNER = JSON.stringify(resourceOwnerSchema.parse(plugin.channelOwner));
  return env;
}

/** A utilityProcess that reports neither spawn nor exit must not hang the launch. */
export const PLUGIN_SPAWN_TIMEOUT_MS = 10_000;

export function builtinProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const key = name.toUpperCase();
    if (
      key === "KOBRIXA_RESOURCE_OWNER" ||
      key === "NODE_OPTIONS" ||
      key === "NODE_PATH" ||
      key === "ELECTRON_RUN_AS_NODE"
    )
      delete environment[name];
  }
  return environment;
}
async function launchNode(
  plugin: LaunchablePlugin,
  onOutput: (line: string) => void,
  spawnTimeoutMs: number,
): Promise<PluginProcess> {
  const child = utilityProcess.fork(plugin.entry, [], {
    cwd: plugin.directory,
    serviceName: `Kobrixa plugin ${plugin.id}`,
    stdio: "pipe",
    env: {
      ...builtinProcessEnvironment(process.env),
      ...(plugin.channelOwner
        ? { KOBRIXA_RESOURCE_OWNER: JSON.stringify(resourceOwnerSchema.parse(plugin.channelOwner)) }
        : {}),
    },
  });
  let killSent = false;
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    if (value === "SIGKILL") killSent = true;
    try {
      if (child.pid !== undefined) process.kill(child.pid, value);
      else child.kill();
    } catch {
      /* An already-exited process has no signal target. */
    }
  };
  const exits = new ExitSignal();
  const tail = new OutputTail(onOutput);
  let ended = false;
  let abandoned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ports: InstanceType<typeof MessageChannelMain> | undefined;
  let rejectStart: ((error: Error) => void) | undefined;
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk, "stderr"));
  const closePorts = () => {
    ports?.port1.close();
    ports?.port2.close();
  };
  child.once("exit", (code) => {
    ended = true;
    clearTimeout(timer);
    closePorts();
    tail.end();
    exits.emit({ code });
    rejectStart?.(new PluginError("PLUGIN_E_LAUNCH", "Plugin exited during launch."));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      rejectStart = reject;
      timer = setTimeout(() => {
        abandoned = true;
        signal("SIGKILL");
        reject(
          new PluginError(
            "PLUGIN_E_LAUNCH",
            `The plugin process did not start within ${spawnTimeoutMs} ms.`,
          ),
        );
      }, spawnTimeoutMs);
      child.once("spawn", () => {
        clearTimeout(timer);
        if (abandoned || ended) {
          signal("SIGKILL");
          return;
        }
        resolve();
      });
    });
    rejectStart = undefined;
    if (ended || abandoned) throw new Error("Plugin exited before channel handoff.");
    ports = new MessageChannelMain();
    child.postMessage({ type: "kobrixa-plugin-port" }, [ports.port2]);
    ports.port1.start();
    if (ended) throw new Error("Plugin exited during channel handoff.");
    const channel = ports.port1;
    const kill = escalatingKill(
      exits,
      () => signal("SIGTERM"),
      () => signal("SIGKILL"),
    );
    return {
      send: (message) => {
        if (ended) throw new Error("Plugin process exited.");
        channel.postMessage(message);
      },
      onMessage: (listener) => {
        const receive = (event: Electron.MessageEvent) => {
          if (typeof event.data === "string") listener(event.data);
        };
        channel.on("message", receive);
        return () => channel.off("message", receive);
      },
      onExit: (listener) => exits.subscribe(listener),
      ...kill,
      stderrTail: () => tail.text(),
    };
  } catch (error) {
    abandoned = true;
    closePorts();
    if (!ended && !killSent) signal("SIGKILL");
    throw error instanceof PluginError
      ? error
      : new PluginError("PLUGIN_E_LAUNCH", "Plugin channel could not be started.");
  } finally {
    clearTimeout(timer);
    rejectStart = undefined;
  }
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
      env: {
        ...channelEnvironment(plugin),
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
  };
}
