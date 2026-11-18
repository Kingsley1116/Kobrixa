import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  validateDatasetDeclarationV2,
  validateDatasetHeaderV2,
  validateDatasetChunkV2,
  validateDatasetV2,
} from "./ui-v2-data.js";

const cases = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures/declarative-ui-v2/data/semantic-cases.json", import.meta.url),
    "utf8",
  ),
) as { name: string; op: string; args: unknown[]; valid: boolean }[];

it.each(cases)("Python/JS shared dataset admission: $name", ({ op, args, valid }) => {
  const run = () => {
    switch (op) {
      case "declaration":
        return validateDatasetDeclarationV2(args[0]);
      case "header":
        return validateDatasetHeaderV2(args[0]);
      case "chunk":
        return validateDatasetChunkV2(args[0]);
      case "dataset":
        return validateDatasetV2(validateDatasetDeclarationV2(args[0]), args[1], args[2]);
      default:
        throw new Error(`Unknown fixture operation: ${op}`);
    }
  };
  expect(["declaration", "header", "chunk", "dataset"]).toContain(op);
  if (valid) expect(run).not.toThrow();
  else expect(run).toThrow();
});
