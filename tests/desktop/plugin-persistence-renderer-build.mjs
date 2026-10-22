import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Build only. Starting Electron and approving native mounts remain separate steps.
export async function buildFoundationRenderer(directory) {
  assert.ok(path.isAbsolute(directory));
  await mkdir(directory, { recursive: true });
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const { build } = require("esbuild");
  const vite = await import(pathToFileURL(require.resolve("vite")).href);
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, [source]]) => [
      name,
      path.join(root, source),
    ]),
  );
  const sourceHashes = new Map();
  async function recordSource(source) {
    if (source.includes("/node_modules/") || source.startsWith("\0")) return;
    const file = source.split("?", 1)[0];
    assert.ok(file.startsWith(root), `Renderer source escaped checkout: ${source}`);
    sourceHashes.set(path.relative(root, file), digest(await readFile(file)));
  }
  const preload = path.join(directory, "preload.cjs");
  const bundled = await build({
    entryPoints: [path.join(root, "apps/desktop/src/preload/index.ts")],
    outfile: preload,
    bundle: true,
    metafile: true,
    platform: "node",
    format: "cjs",
    alias,
    external: ["electron"],
    plugins: [rawResourcePlugin()],
  });
  for (const input of Object.keys(bundled.metafile.inputs))
    await recordSource(path.resolve(root, input));
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
    base: "./",
    resolve: { alias, dedupe: ["react", "react-dom"] },
    plugins: [
      {
        name: "persistence-production-renderer-shell",
        async generateBundle() {
          for (const input of this.getModuleIds())
            if (input.startsWith("/")) await recordSource(input);
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) => {
            assert.ok(html.includes('src="/src/renderer/index.tsx"'));
            return html.replace(
              'src="/src/renderer/index.tsx"',
              `src="/@fs/${path.join(root, "tests/desktop/plugin-persistence-renderer.tsx")}"`,
            );
          },
        },
      },
    ],
    build: { outDir: path.join(directory, "renderer"), emptyOutDir: true },
  });
  const files = [
    "preload.cjs",
    ...(await readdir(path.join(directory, "renderer"), { recursive: true }))
      .filter((file) => /\.(html|js|css)$/.test(file))
      .map((file) => `renderer/${file}`),
  ].sort();
  const sha256 = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, digest(await readFile(path.join(directory, file)))]),
    ),
  );
  const artifact = {
    format: 1,
    root: directory,
    rendererUrl: pathToFileURL(path.join(directory, "renderer/index.html")).href,
    preload,
    sha256,
    sourceSha256: Object.fromEntries([...sourceHashes].sort(([a], [b]) => a.localeCompare(b))),
  };
  const receipt = path.join(directory, "renderer-artifact.json");
  await writeFile(receipt, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  return { receipt, artifact };
}

export async function readFoundationRenderer(receipt) {
  const bytes = await readFile(receipt);
  const artifact = JSON.parse(bytes);
  assert.equal(artifact.format, 1);
  assert.equal(artifact.root, path.dirname(receipt));
  assert.equal(artifact.preload, path.join(artifact.root, "preload.cjs"));
  assert.equal(
    artifact.rendererUrl,
    pathToFileURL(path.join(artifact.root, "renderer/index.html")).href,
  );
  assert.ok(artifact.sha256["preload.cjs"] && artifact.sha256["renderer/index.html"]);
  assert.ok(
    Object.keys(artifact.sha256).some(
      (file) => file.startsWith("renderer/") && file.endsWith(".js"),
    ),
  );
  for (const [relative, hash] of Object.entries(artifact.sha256)) {
    assert.ok(!path.isAbsolute(relative) && path.normalize(relative) === relative);
    assert.ok(!relative.split(path.sep).includes(".."));
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.equal(
      digest(await readFile(path.join(artifact.root, relative))),
      hash,
      `Changed renderer artifact: ${relative}`,
    );
  }
  return { ...artifact, receiptSha256: digest(bytes) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-persistence-renderer-"));
  const result = await buildFoundationRenderer(directory);
  console.log(`Persistence renderer artifact: ${result.receipt}`);
}
