import path from "node:path";

export function persistenceWorkerPath(input: {
  packaged: boolean;
  resourcesPath: string;
  buildRoot: string;
}): string {
  const root = input.packaged ? input.resourcesPath : input.buildRoot;
  if (!path.isAbsolute(root)) throw new Error("Persistence worker root must be absolute");
  return input.packaged
    ? path.join(root, "app.asar.unpacked", ".vite", "build", "persistence-worker.cjs")
    : path.join(root, "persistence-worker.cjs");
}
