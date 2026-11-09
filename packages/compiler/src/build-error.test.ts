import { expect, it } from "vitest";
import { BuildError, failedBuild, type BuildErrorCode } from "./build-error.js";
import { diagnostic } from "./diagnostics.js";

it.each<BuildErrorCode>([
  "BUILD0001",
  "BUILD1001",
  "BUILD1002",
  "BUILD1003",
  "BUILD1004",
  "BUILD1005",
  "BUILD1006",
  "BUILD9000",
])("preserves %s while keeping its diagnostic detail free of the code prefix", (code) => {
  const detail = "No built-in compiler factory matches the provider snapshot.";
  const error = new BuildError(code, detail);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("BuildError");
  expect(error.code).toBe(code);
  expect(error.message).toBe(`${code}: ${detail}`);
  expect(error.detail).toBe(detail);
  expect(failedBuild("build-1", "ev3-native", error, "main.bp")).toEqual({
    buildId: "build-1",
    target: "ev3-native",
    success: false,
    artifacts: [],
    diagnostics: [diagnostic(code, code === "BUILD0001" ? "Build cancelled." : detail, "main.bp")],
  });
});

it("appends the failure without mutating earlier diagnostics", () => {
  const earlier = diagnostic("BUILD1002", "Earlier diagnostic.", "main.bp");
  const diagnostics = [earlier];
  const result = failedBuild(
    "build-1",
    "ev3-native",
    new BuildError("BUILD1001", "No built-in compiler factory matches the provider snapshot."),
    "main.bp",
    diagnostics,
  );
  expect(result.diagnostics).toEqual([
    earlier,
    diagnostic(
      "BUILD1001",
      "No built-in compiler factory matches the provider snapshot.",
      "main.bp",
    ),
  ]);
  expect(diagnostics).toEqual([earlier]);
  expect(result.diagnostics).not.toBe(diagnostics);
  expect(result.artifacts).toEqual([]);
});

it("normalizes AbortError to BUILD0001 and the fixed cancellation message", () => {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  expect(failedBuild("build-1", "ev3-native", error, "main.bp").diagnostics).toEqual([
    diagnostic("BUILD0001", "Build cancelled.", "main.bp"),
  ]);
});

it.each([
  { error: new Error("Unexpected failure."), message: "Unexpected failure." },
  { error: "Unexpected failure.", message: "Unexpected failure." },
  { error: null, message: "null" },
])("maps unexpected errors to BUILD9000: $message", ({ error, message }) => {
  expect(failedBuild("build-1", "ev3-native", error, "main.bp")).toEqual({
    buildId: "build-1",
    target: "ev3-native",
    success: false,
    artifacts: [],
    diagnostics: [diagnostic("BUILD9000", message, "main.bp")],
  });
});
