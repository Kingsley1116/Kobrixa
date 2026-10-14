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

async function launchNode(plugin: LaunchablePlugin): Promise<PluginProcess> {
  const child = utilityProcess.fork(plugin.entry, [], {
    cwd: plugin.directory,
    serviceName: `Kobrixa plugin ${plugin.id}`,
    stdio: "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("exit", (code) =>
      reject(new Error(`The plugin process exited during launch (code ${code}).`)),
    );
  });
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: "kobrixa-plugin-port" }, [port2]);
  port1.start();
  const tail = new OutputTail();
  child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
  const exits = new ExitSignal();
  child.once("exit", (code) => {
    port1.close();
    exits.emit({ code });
  });
  // utilityProcess.kill() sends SIGTERM on POSIX; escalate to SIGKILL when it is ignored.
  const kill = escalatingKill(
    exits,
    () => child.kill(),
    () => {
      try {
        if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
        else child.kill();
      } catch {
        /* The process already exited. */
      }
    },
  );
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

export function createDesktopLauncher(options: { python?: string }): PluginLauncher {
  return async (plugin) => {
    if (plugin.runtime === "node") return launchNode(plugin);
    if (!options.python)
      throw new PluginError(
        "PLUGIN_E_LAUNCH",
        "Start Kobrixa with --plugin-python=<interpreter> to run Python development plugins.",
      );
    return spawnPluginProcess(options.python, ["-u", plugin.entry], {
      cwd: plugin.directory,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
  };
}
