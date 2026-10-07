import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function classifyPaths(paths) {
  const result = { web: false, desktop: false };
  for (const path of paths) {
    if (path.startsWith("apps/web/") || path.startsWith("docs/")) result.web = true;
    else if (
      path.startsWith("apps/desktop/") ||
      path.startsWith("apps/collab/") ||
      path.startsWith("examples/") ||
      path.startsWith("tests/") ||
      (path.startsWith("tools/") && !path.startsWith("tools/ci/")) ||
      path === ".github/workflows/release.yml"
    )
      result.desktop = true;
    else if (["README.md", "README.zh-TW.md", "CONTRIBUTING.md", "LICENSE"].includes(path)) {
      // These files are checked by the always-on formatting job.
    } else {
      // Shared packages/frontends/assets, CI/toolchain settings, and unknown paths
      // conservatively require both products. New directories cannot silently skip CI.
      result.web = result.desktop = true;
    }
  }
  return result;
}

export function detectChanges(
  eventName,
  event,
  git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }),
) {
  const both = { web: true, desktop: true };
  if (eventName === "workflow_dispatch") return both;
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  const head = eventName === "pull_request" ? event.pull_request?.head?.sha : event.after;
  const valid = (sha) =>
    typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha);
  if (!["pull_request", "push"].includes(eventName) || !valid(base) || !valid(head)) return both;
  try {
    // PRs compare against the merge base; pushes cover every commit in the push.
    // No rename detection: moving a file across products must validate both sides.
    const range = `${base}${eventName === "pull_request" ? "..." : ".."}${head}`;
    const names = git(["diff", "--name-only", "--no-renames", "-z", range, "--"]);
    return classifyPaths(names.split("\0").filter(Boolean));
  } catch {
    // Missing history (e.g. a force-push) must expand checks, never skip them.
    console.warn("Unable to compare revisions; validating both products.");
    return both;
  }
}

export function requiredChecksPassed(needs) {
  if (needs.changes?.result !== "success" || needs.quality?.result !== "success") return false;
  return [
    ["web", "web"],
    ["desktop", "platform"],
  ].every(([output, job]) => {
    const required = needs.changes.outputs?.[output];
    return required === "true"
      ? needs[job]?.result === "success"
      : required === "false" && needs[job]?.result === "skipped";
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "result") {
    const needs = JSON.parse(process.env.CI_RESULTS ?? "{}");
    if (!requiredChecksPassed(needs))
      throw new Error("A required CI job failed, was cancelled, or did not run.");
    console.log("All required checks passed; unaffected products were skipped.");
  } else {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const result = detectChanges(process.env.GITHUB_EVENT_NAME, event);
    const output = `web=${result.web}\ndesktop=${result.desktop}\n`;
    appendFileSync(process.env.GITHUB_OUTPUT, output);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Affected products\n\n- Website: ${result.web}\n- Desktop: ${result.desktop}\n`,
      );
    console.log(output.trim());
  }
}
