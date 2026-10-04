import { describe, expect, it } from "vitest";
import { DIAGNOSTIC_HELP, DIAGNOSTIC_HELP_VARIANTS } from "@kobrixa/compiler/diagnostic-help";
import { analyzeBasicPlusProject } from "./analysis.js";
import { parse } from "./parser.js";

describe("published diagnostic examples", () => {
  for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS]) {
    if (help.example?.language !== "bp") continue;
    it(`${help.code}${help.helpKey ? ` (${help.helpKey})` : ""} has a valid corrected BASIC Plus example`, () => {
      const content = help.example!.after;
      expect(parse("main.bp", content).diagnostics).toEqual([]);
      const analysis = analyzeBasicPlusProject(
        {
          root: "/diagnostic-example",
          manifest: {
            schemaVersion: 1,
            name: "diagnostic-example",
            language: "bp",
            entry: "main.bp",
            target: "ev3-native",
            assets: [],
            outputDir: "build",
          },
          // BP1010 demonstrates an Include of an existing project dependency.
          sources: [
            { path: "main.bp", content },
            { path: "settings.bpi", content: "" },
          ],
          assets: [],
        },
        new AbortController().signal,
      );
      expect(analysis.diagnostics).toEqual([]);
    });
  }
});
