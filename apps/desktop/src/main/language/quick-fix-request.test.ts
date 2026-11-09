import { expect, it } from "vitest";
import { z } from "zod";
import {
  quickFixRequestSchema,
  languageFeatureRequestSchema,
  languageSyncRequestSchema,
  completionSyncRequestSchema,
  validateQuickFixRequest,
} from "./quick-fix-request.js";

const request = (diagnostic: Record<string, unknown>) => ({
  epoch: 1,
  requestId: "r1",
  session: "s",
  revision: 1,
  analysisVersion: 1,
  file: "main.bp",
  diagnostic: { range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, ...diagnostic },
});
it("requires a source and accepts plugin code formats", () => {
  expect(quickFixRequestSchema.safeParse(request({ code: "BP1015" })).success).toBe(false);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "kobrixa.basic-plus" }))
      .success,
  ).toBe(true);
  expect(
    quickFixRequestSchema.safeParse(request({ code: "ACME.e-1", source: "acme.x" })).success,
  ).toBe(true);
  expect(quickFixRequestSchema.safeParse(request({ code: "1BAD", source: "acme.x" })).success).toBe(
    false,
  );
  expect(
    quickFixRequestSchema.safeParse(request({ code: "BP1015", source: "Not An Id" })).success,
  ).toBe(false);
});

function assertStructuralSchema(schema: z.ZodType): void {
  const seen = new Set<object>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const node = value as Record<string, unknown>;
    expect(node.check).not.toBe("custom");
    expect(node.type).not.toBe("transform");
    expect(node.type).not.toBe("pipe");
    if (node._zod) walk((node._zod as { def: unknown }).def);
    for (const child of Object.values(node)) walk(child);
  };
  walk(schema._zod.def);
}

it("detects nested custom checks, transforms and pipes in the structural schema audit", () => {
  for (const schema of [
    z.strictObject({ payload: z.array(z.string().refine(() => true)) }),
    z.strictObject({ payload: z.transform((value) => value) }),
    z.strictObject({ payload: z.string().pipe(z.string()) }),
  ])
    expect(() => assertStructuralSchema(schema)).toThrow();
});

it("exports request schemas without refinements and rejects absent epochs", () => {
  assertStructuralSchema(quickFixRequestSchema);
  assertStructuralSchema(languageFeatureRequestSchema);
  assertStructuralSchema(languageSyncRequestSchema);
  assertStructuralSchema(completionSyncRequestSchema);
  expect(
    quickFixRequestSchema.safeParse({
      ...request({ code: "BP1043", source: "kobrixa.basic-plus" }),
      file: "a\u0000b",
    }).success,
  ).toBe(false);
  const value = {
    requestId: "r",
    session: "s",
    revision: 1,
    analysisVersion: 1,
    query: { kind: "hover", file: "main.csx", line: 1, column: 1 },
  };
  expect(languageFeatureRequestSchema.safeParse(value).success).toBe(false);
  expect(languageFeatureRequestSchema.safeParse({ ...value, epoch: 1 }).success).toBe(true);
  expect(
    languageFeatureRequestSchema.safeParse({ ...value, epoch: 1, pluginId: "test.forged" }).success,
  ).toBe(false);
});

it("rejects reversed ranges after structural parsing", () => {
  const value = request({
    code: "BP1043",
    source: "kobrixa.basic-plus",
    range: { startLine: 2, startColumn: 5, endLine: 1, endColumn: 1 },
  });
  expect(quickFixRequestSchema.safeParse(value).success).toBe(true);
  expect(() => validateQuickFixRequest(value)).toThrow("range is reversed");
});
