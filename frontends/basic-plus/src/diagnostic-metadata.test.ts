import { describe, expect, it } from "vitest";
import type { SourceProject } from "@kobrixa/compiler";
import { getDiagnosticHelp } from "@kobrixa/compiler/diagnostic-help";
import { BasicPlusFrontend } from "./index.js";

function project(content: string): SourceProject {
  return {
    root: "/diagnostic-metadata",
    manifest: {
      schemaVersion: 1,
      name: "metadata",
      language: "bp",
      entry: "main.bp",
      target: "ev3-native",
      assets: [],
      outputDir: "build",
    },
    sources: [{ path: "main.bp", content }],
    assets: [],
  };
}

describe("producer-selected Basic Plus diagnostic help", () => {
  it.each([
    {
      source: "Break",
      helpKey: "break-outside-loop",
      message: "Break can only be used inside For or While.",
    },
    {
      source: 'Sub Read(Out String value)\n  value = "text"\nEndSub\nNumber target\nRead(target)',
      helpKey: "out-type",
      message: "Output argument 1 of 'Read' must have type string.",
    },
  ])("preserves BP2006 while selecting $helpKey", async ({ source, helpKey, message }) => {
    const result = await new BasicPlusFrontend().compile(
      project(source),
      new AbortController().signal,
    );
    const diagnostic = result.diagnostics.find((item) => item.code === "BP2006");
    expect(diagnostic).toMatchObject({
      code: "BP2006",
      message,
      helpKey,
      severity: "error",
      file: "main.bp",
    });
    expect(getDiagnosticHelp(diagnostic!.code, diagnostic!.helpKey)?.helpKey).toBe(helpKey);
  });
});
