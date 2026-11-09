import { expect, it } from "vitest";
import type { CompileResult } from "../../shared/api.js";
import { deploymentPath, deploymentUnavailableReason } from "./build-path.js";
const result: CompileResult = {
  buildId: "build",
  target: "toy-vm",
  deploy: "ev3",
  success: true,
  diagnostics: [],
  artifacts: [
    {
      slot: "program",
      kind: "not-rbf",
      role: "deploy-main",
      mediaType: "application/octet-stream",
      path: "C:\\project\\build\\card.bin",
      sha256: "abc",
      byteLength: 1,
    },
  ],
};
it("uses deploy capability and main role while preserving Folder", () => {
  expect(deploymentPath(result)).toBe("/home/root/lms2012/prjs/card.bin");
  expect(
    deploymentPath({ ...result, runtimeDirectory: "/home/root/lms2012/prjs/SD_Card/Lesson" }),
  ).toBe("/home/root/lms2012/prjs/SD_Card/Lesson/card.bin");
  const local = { ...result };
  delete local.deploy;
  expect(deploymentPath(local)).toBeUndefined();
  expect(deploymentPath({ ...result, success: false })).toBeUndefined();
  expect(deploymentPath({ ...result, artifacts: [] })).toBeUndefined();
  expect(deploymentUnavailableReason("BUILD1005", "en")).toContain("cannot deploy");
  expect(deploymentUnavailableReason("BUILD1005", "zh-TW")).toContain("無法部署");
});
