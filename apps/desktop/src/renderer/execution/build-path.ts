import type { CompileResult } from "../../shared/api.js";
export function deploymentPath(result: CompileResult): string | undefined {
  if (!result.success || result.deploy !== "ev3") return undefined;
  const mains = result.artifacts.filter((artifact) => artifact.role === "deploy-main");
  if (mains.length !== 1 || !mains[0]!.byteLength) return undefined;
  const filename = mains[0]!.path.replaceAll("\\", "/").split("/").at(-1);
  if (!filename) return undefined;
  return `${result.runtimeDirectory ?? "/home/root/lms2012/prjs"}/${filename}`;
}
export function deploymentUnavailableReason(
  code: "BUILD1005" | undefined,
  locale: "en" | "zh-TW",
): string | undefined {
  if (!code) return undefined;
  return locale === "zh-TW"
    ? "建置已成功；這個目標無法部署至 EV3。"
    : "Build succeeded; this target cannot deploy to EV3.";
}
