import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPaths, detectChanges, requiredChecksPassed } from "./changes.mjs";
import { parse as parseYaml } from "yaml";

const both = { web: true, desktop: true };

test("declarative UI fixtures and guides route to their existing CI owners", () => {
  for (const file of [
    "tests/desktop/declarative-ui-main.ts",
    "tests/desktop/declarative-ui-motion-main.ts",
    "tests/desktop/declarative-ui-load-report.mjs",
    "tests/desktop/builtin-process-installed.mjs",
    "tests/desktop/fixtures/declarative-ui/consumer.py",
  ])
    assert.deepEqual(classifyPaths([file]), { desktop: true, web: false });
  for (const file of ["docs/en/plugin-declarative-ui.md", "docs/zh-TW/plugin-declarative-ui.md"])
    assert.deepEqual(classifyPaths([file]), { desktop: false, web: true });
});
test("P160 scripts include actual transport, browser and maximum-load runners", () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    scripts["test:declarative-ui"],
    "node --test tests/desktop/declarative-ui-*.test.mjs tests/desktop/builtin-process-*.test.mjs",
  );
  for (const name of ["test", "test:ci", "test:desktop"])
    assert.ok(scripts[name].includes("pnpm test:declarative-ui"), name);
  const smoke = scripts["test:declarative-ui:smoke"];
  assert.ok(smoke.includes("declarative-ui-run.mjs --transport-only"));
  assert.ok(smoke.includes("declarative-ui-browser-run.mjs"));
  assert.ok(smoke.includes("declarative-ui-motion-run.mjs --backpressure"));
  assert.ok(smoke.includes("declarative-ui-motion-run.mjs --load"));
  assert.ok(
    !smoke.includes("--plain-glyphs"),
    "diagnostic glyph mode cannot replace ordinary product acceptance",
  );
  assert.ok(scripts["test:desktop:packaged"].includes("packaged-smoke.mjs"));
  assert.ok(scripts["test:desktop:packaged"].includes("builtin-process-installed.mjs"));
  assert.ok(scripts["test:plugins:smoke"].includes("run-plugins-smoke.mjs"));
  assert.ok(scripts["test:static-languages:smoke"].includes("static-languages-run.mjs"));
});
test("P160 native smoke runs after build on every desktop platform", () => {
  const workflow = parseYaml(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const steps = workflow.jobs.platform.steps;
  const build = steps.findIndex((step) => step.run === "pnpm build:desktop");
  const smoke = steps.findIndex((step) => step.name === "Declarative UI bridge and SDK acceptance");
  const packaged = steps.findIndex((step) => step.name === "Smoke test the packaged application");
  assert.ok(build >= 0 && smoke > build && packaged > smoke);
  assert.equal(steps[smoke].shell, "bash");
  assert.ok(!steps[smoke].if);
  assert.match(steps[smoke].run, /xvfb-run -a pnpm test:declarative-ui:smoke/);
  assert.match(steps[smoke].run, /pnpm_config_verify_deps_before_run=false/);
});
const base = "a".repeat(40),
  head = "b".repeat(40);

test("website sources, Worker and website-imported docs do not trigger desktop builds", () => {
  for (const path of [
    "apps/web/src/main.tsx",
    "apps/web/worker/index.ts",
    "apps/web/migrations/0001.sql",
    "docs/en/product.md",
  ])
    assert.deepEqual(classifyPaths([path]), { web: true, desktop: false });
});
test("desktop code, fixtures, release tools and release workflow do not trigger website checks", () => {
  for (const path of [
    "apps/desktop/src/main.ts",
    "apps/collab/src/room.ts",
    "examples/test/main.bp",
    "tests/bytecode/test.mjs",
    "tools/release/archive.mjs",
    ".github/workflows/release.yml",
  ])
    assert.deepEqual(classifyPaths([path]), { web: false, desktop: true });
});
test("shared code, configs and unknown paths require both products", () => {
  for (const path of [
    "packages/ir/src/index.ts",
    "frontends/basic-plus/src/parser.ts",
    "assets/brand/icon.svg",
    "pnpm-lock.yaml",
    "package.json",
    "tsconfig.base.json",
    ".github/actions/setup/action.yml",
    ".github/workflows/ci.yml",
    "tools/ci/changes.mjs",
    "new-app/main.ts",
  ])
    assert.deepEqual(classifyPaths([path]), both);
  assert.deepEqual(classifyPaths(["apps/web/a.ts", "apps/desktop/b.ts"]), both);
});
test("readme-only and empty changes still allow the common job without product builds", () => {
  assert.deepEqual(classifyPaths(["README.md", "CONTRIBUTING.md"]), { web: false, desktop: false });
  assert.deepEqual(classifyPaths([]), { web: false, desktop: false });
});
test("PRs use merge-base diff and pushes compare the whole push", () => {
  for (const [eventName, event, separator] of [
    ["pull_request", { pull_request: { base: { sha: base }, head: { sha: head } } }, "..."],
    ["push", { before: base, after: head }, ".."],
  ]) {
    assert.deepEqual(
      detectChanges(eventName, event, (args) => {
        assert.deepEqual(args, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          `${base}${separator}${head}`,
          "--",
        ]);
        return "apps/web/file with spaces.ts\0apps/web/file\nnewline.ts\0";
      }),
      { web: true, desktop: false },
    );
  }
});
test("manual runs, new branches, invalid revisions and unavailable history run both", () => {
  for (const [name, event] of [
    ["workflow_dispatch", {}],
    ["push", { before: "0".repeat(40), after: head }],
    ["pull_request", {}],
    ["other", {}],
    ["push", { before: "--bad", after: head }],
  ])
    assert.deepEqual(
      detectChanges(name, event, () => assert.fail("should not run git")),
      both,
    );
  assert.deepEqual(
    detectChanges("push", { before: base, after: head }, () => {
      throw new Error("missing ref");
    }),
    both,
  );
});
test("large changesets are not truncated to a service API file limit", () => {
  const paths = Array.from({ length: 350 }, (_, i) => `apps/web/${i}.ts`).concat(
    "apps/desktop/main.ts",
  );
  assert.deepEqual(
    detectChanges("push", { before: base, after: head }, () => paths.join("\0")),
    both,
  );
});
test("actual git moves and deletions include the affected original product", () => {
  const dir = mkdtempSync(join(tmpdir(), "kobrixa-ci-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    git(["init", "--quiet"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "CI test"]);
    mkdirSync(join(dir, "apps/web"), { recursive: true });
    mkdirSync(join(dir, "apps/desktop"), { recursive: true });
    writeFileSync(join(dir, "apps/web/shared.ts"), "example\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    const before = git(["rev-parse", "HEAD"]).trim();
    git(["mv", "apps/web/shared.ts", "apps/desktop/shared.ts"]);
    git(["commit", "--quiet", "-m", "move"]);
    const moved = git(["rev-parse", "HEAD"]).trim();
    assert.deepEqual(detectChanges("push", { before, after: moved }, git), both);
    git(["rm", "--quiet", "apps/desktop/shared.ts"]);
    git(["commit", "--quiet", "-m", "delete"]);
    assert.deepEqual(
      detectChanges("push", { before: moved, after: git(["rev-parse", "HEAD"]).trim() }, git),
      { web: false, desktop: true },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("final gate accepts only explicitly unaffected skipped jobs", () => {
  const needs = {
    changes: { result: "success", outputs: { web: "true", desktop: "false" } },
    quality: { result: "success" },
    web: { result: "success" },
    platform: { result: "skipped" },
  };
  assert.equal(requiredChecksPassed(needs), true);
  for (const state of ["failure", "cancelled", "skipped"])
    assert.equal(requiredChecksPassed({ ...needs, web: { result: state } }), false);
  assert.equal(requiredChecksPassed({ ...needs, quality: { result: "failure" } }), false);
  assert.equal(requiredChecksPassed({ ...needs, changes: { result: "failure" } }), false);
  assert.equal(
    requiredChecksPassed({ ...needs, changes: { result: "success", outputs: {} } }),
    false,
  );
  assert.equal(
    requiredChecksPassed({
      ...needs,
      changes: { result: "success", outputs: { web: "true", desktop: "true" } },
    }),
    false,
  );
  assert.equal(
    requiredChecksPassed({
      ...needs,
      changes: { result: "success", outputs: { web: "false", desktop: "false" } },
      web: { result: "skipped" },
    }),
    true,
  );
});
test("dotenv credentials are ignored at every depth but example templates remain trackable", () => {
  const dir = mkdtempSync(join(tmpdir(), "kobrixa-ignore-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    writeFileSync(
      join(dir, ".gitignore"),
      readFileSync(new URL("../../.gitignore", import.meta.url)),
    );
    const privateNames = [
      ".env",
      ".env.local",
      ".env.production",
      "apps/web/.env",
      "apps/web/.env.production.local",
      "apps/desktop/.env.test",
    ];
    const templates = [
      ".env.example",
      "apps/web/.env.example",
      "apps/web/.env.production.example",
      "apps/web/.dev.vars.example",
    ];
    const ignored = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: dir,
      input: [...privateNames, ...templates].join("\n"),
      encoding: "utf8",
    })
      .trim()
      .split("\n");
    assert.deepEqual(ignored, privateNames);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
