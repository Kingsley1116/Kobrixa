import { z } from "zod";

const relativePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.split("/").some((part) => part === ".." || part === "."),
  );
const position = z.number().int().min(1).max(100_000_000);
export const workspaceViewSchema = z.object({
  workspaceId: z.string().uuid(),
  files: z.array(relativePath.min(1)).max(10000),
  activeFile: relativePath.min(1).optional(),
  selectedTreePath: relativePath,
  expandedTreePaths: z.array(relativePath).max(10000),
  locations: z.record(
    relativePath.min(1),
    z.object({
      line: position,
      column: position,
      endLine: position,
      endColumn: position,
      scrollTop: z.number().finite().min(0),
      scrollLeft: z.number().finite().min(0),
    }),
  ),
});
export const workspaceSessionSchema = z.object({
  projects: z.array(workspaceViewSchema).max(1000),
  activeWorkspaceId: z.string().uuid().optional(),
});
export const storedWorkspaceSessionSchema = z.object({
  version: z.literal(1),
  projects: z
    .array(
      workspaceViewSchema.extend({
        inputPath: z.string().min(1).max(32768),
        selectedEntry: relativePath.min(1).optional(),
      }),
    )
    .max(1000),
  activeWorkspaceId: z.string().uuid().optional(),
});
