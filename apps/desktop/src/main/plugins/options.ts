import path from "node:path";
import type { PluginLocale } from "@kobrixa/plugin-protocol";

export interface PluginOptions {
  developmentDirectories: string[];
  python?: string;
  safeMode: boolean;
}
interface CommandLine {
  getSwitchValue(name: string): string;
  hasSwitch(name: string): boolean;
}

/** Development plugins load only from folders named explicitly on the command line. */
export function pluginOptions(commandLine: CommandLine, cwd = process.cwd()): PluginOptions {
  const directories = commandLine
    .getSwitchValue("plugin-dev-dir")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(cwd, item));
  const python = commandLine.getSwitchValue("plugin-python").trim();
  return {
    developmentDirectories: [...new Set(directories)],
    ...(python ? { python } : {}),
    safeMode: commandLine.hasSwitch("safe-mode"),
  };
}

export const pluginLocale = (appLocale: string): PluginLocale =>
  appLocale.toLowerCase().startsWith("zh") ? "zh-TW" : "en";
