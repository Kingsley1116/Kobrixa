import { expect, it } from "vitest";
import type { CompileResult } from "../../shared/api.js";
import { deploymentPath } from "./build-path.js";
it("uses the built executable and SD mount for upload, run and delete", () => {
  const result: CompileResult = {
    buildId: "build-path",
    target: "ev3-native",
    deploy: "ev3",
    success: true,
    diagnostics: [],
    artifacts: [
      {
        slot: "program",
        kind: "rbf",
        role: "deploy-main",
        mediaType: "application/octet-stream",
        byteLength: 1,
        path: "C:\\project\\build\\card.rbf",
        sha256: "test",
      },
    ],
  };
  expect(deploymentPath(result)).toBe("/home/root/lms2012/prjs/card.rbf");
  expect(
    deploymentPath({ ...result, runtimeDirectory: "/home/root/lms2012/prjs/SD_Card/Lesson" }),
  ).toBe("/home/root/lms2012/prjs/SD_Card/Lesson/card.rbf");
  expect(deploymentPath({ ...result, success: false })).toBeUndefined();
  expect(deploymentPath({ ...result, artifacts: [] })).toBeUndefined();
});
