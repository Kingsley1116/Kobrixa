import { expect, it } from "vitest";
import { deploymentPath } from "./build-path.js";
it("uses the built executable and SD mount for upload, run and delete", () => {
  const result = {
    success: true,
    diagnostics: [],
    artifacts: [{ kind: "rbf" as const, path: "C:\\project\\build\\card.rbf", sha256: "test" }],
  };
  expect(deploymentPath(result)).toBe("/home/root/lms2012/prjs/card.rbf");
  expect(
    deploymentPath({ ...result, runtimeDirectory: "/home/root/lms2012/prjs/SD_Card/Lesson" }),
  ).toBe("/home/root/lms2012/prjs/SD_Card/Lesson/card.rbf");
  expect(deploymentPath({ ...result, success: false })).toBeUndefined();
  expect(deploymentPath({ ...result, artifacts: [] })).toBeUndefined();
});
