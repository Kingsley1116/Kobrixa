import path from "node:path";
import { expect, it } from "vitest";
import { pluginLocale, pluginOptions } from "./options.js";

const commandLine = (switches: Record<string, string>) => ({
  getSwitchValue: (name: string) => switches[name] ?? "",
  hasSwitch: (name: string) => name in switches,
});

it("parses development folders, interpreter and safe mode", () => {
  const value = pluginOptions(
    commandLine({
      "plugin-dev-dir": ["a", "/abs/b", "a", ""].join(path.delimiter),
      "plugin-python": " /usr/bin/python3 ",
      "safe-mode": "",
    }),
    "/work",
  );
  expect(value).toEqual({
    developmentDirectories: [path.resolve("/work", "a"), path.resolve("/abs/b")],
    python: "/usr/bin/python3",
    safeMode: true,
  });
  expect(pluginOptions(commandLine({}))).toEqual({ developmentDirectories: [], safeMode: false });
});

it("maps the application locale", () => {
  expect(pluginLocale("zh-TW")).toBe("zh-TW");
  expect(pluginLocale("zh-HK")).toBe("zh-TW");
  expect(pluginLocale("en-US")).toBe("en");
});
