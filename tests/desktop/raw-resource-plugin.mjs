import { readFile } from "node:fs/promises";
import path from "node:path";

export function rawResourcePlugin() {
  return {
    name: "kobrixa-raw-resource",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, ({ path: request, resolveDir }) => ({
        path: path.resolve(resolveDir, request.slice(0, -4)),
        namespace: "kobrixa-raw-resource",
      }));
      build.onLoad({ filter: /.*/, namespace: "kobrixa-raw-resource" }, async ({ path: file }) => ({
        contents: await readFile(file, "utf8"),
        loader: "text",
      }));
    },
  };
}
