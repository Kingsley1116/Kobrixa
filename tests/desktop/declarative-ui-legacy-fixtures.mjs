import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { root, fixture } from "./declarative-ui-harness.mjs";

// User-merged 2C is the preserved API 1.4 source; never generate a pretend old SDK
// by changing the current version constant, nor fetch/install a replacement.
const preservedRevision = "0ba37ba";
export async function legacyFixtures(directory, options = {}) {
  const revision = options.revision ?? preservedRevision;
  const sdkVersion = options.sdkVersion ?? "1.4.0";
  const compatibility = options.slot !== undefined;
  const sha = execFileSync("git", ["rev-parse", `${revision}^{commit}`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const paths = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      sha,
      "--",
      "packages/plugin-sdk-js/src",
      "packages/plugin-protocol/src",
      "packages/plugin-protocol/schema",
      "sdks/python/kobrixa",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  const snapshot = path.join(directory, `preserved-${sdkVersion}`);
  const hashes = {};
  for (const file of paths) {
    assert.ok(!file.split("/").includes("..") && !path.isAbsolute(file));
    const content = execFileSync("git", ["show", `${sha}:${file}`], {
      cwd: root,
      // API 1.8 committed schema is 10,459,664 bytes; retain a bounded
      // extraction buffer large enough for the actual preserved source blob.
      maxBuffer: 16 * 1024 * 1024,
    });
    const target = path.join(snapshot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    hashes[file] = createHash("sha256").update(content).digest("hex");
  }
  assert.match(
    await readFile(path.join(snapshot, "packages/plugin-protocol/src/limits.ts"), "utf8"),
    new RegExp(`PLUGIN_API_VERSION = "${sdkVersion.replaceAll(".", "\\.")}"`),
  );
  assert.match(
    await readFile(path.join(snapshot, "sdks/python/kobrixa/_plugin.py"), "utf8"),
    new RegExp(`API_VERSION = "${sdkVersion.replaceAll(".", "\\.")}"`),
  );
  const python = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(Boolean).find(
    (command) =>
      spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"], {
        stdio: "ignore",
      }).status === 0,
  );
  assert.ok(python, "Python 3.10+ is mandatory for old-SDK compatibility");
  const sources = [];
  const artifacts = [];
  const cases = [];
  for (const version of compatibility ? ["old"] : ["old", "new", "old-ui"])
    for (const language of ["js", "py"]) {
      const slug = compatibility
        ? `compat-${options.slot}-${language}`
        : `legacy-${version}-${language}`;
      const persistence = compatibility && Number(sdkVersion.split(".")[1]) >= 7;
      const id = `acceptance.${slug}`;
      const folder = path.join(directory, slug);
      await mkdir(folder);
      const manifest = {
        id,
        version: "0.0.0",
        apiVersion: "^1.4.0",
        permissions: persistence
          ? ["storage.read", "storage.write"]
          : version === "old-ui"
            ? ["ui.panels"]
            : [],
        runtime: {
          kind: language === "js" ? "node" : "python",
          entry: language === "js" ? "main.cjs" : "consumer.py",
        },
        contributes: { commands: [{ id: `${id}.legacy`, title: "Legacy acceptance" }] },
      };
      if (persistence)
        manifest.contributes.commands.push({
          id: `${id}.seed`,
          title: "Seed compatibility checkpoint",
        });
      if (version === "old-ui") {
        manifest.contributes.panels = [
          {
            id: `${id}.panel`,
            title: { en: "Old SDK UI rejection" },
            location: "right",
            resource: { version: 1, path: "panel.json" },
          },
        ];
        await writeFile(
          path.join(folder, "panel.json"),
          JSON.stringify({
            kind: "panel",
            root: "root",
            fields: {},
            data: {},
            nodes: [
              {
                id: "root",
                type: "text",
                emphasis: "normal",
                value: { text: { en: "Must not activate with an old SDK" } },
              },
            ],
          }),
        );
        artifacts.push(`${slug}/panel.json`);
      }
      await writeFile(path.join(folder, "kobrixa-plugin.json"), JSON.stringify(manifest));
      artifacts.push(`${slug}/kobrixa-plugin.json`);
      const sdkRoot = version === "new" ? root : snapshot;
      let schemaSha256;
      if (compatibility) {
        const schema = await readFile(
          path.join(snapshot, "sdks/python/kobrixa/plugin-protocol.schema.json"),
        );
        assert.deepEqual(
          schema,
          await readFile(
            path.join(snapshot, "packages/plugin-protocol/schema/plugin-protocol.schema.json"),
          ),
        );
        assert.equal(
          JSON.parse(schema).$id,
          `https://kobrixa.com/schemas/plugin-protocol/${sdkVersion}.json`,
        );
        await writeFile(path.join(folder, "sdk-schema.json"), schema);
        schemaSha256 = createHash("sha256").update(schema).digest("hex");
        artifacts.push(`${slug}/sdk-schema.json`);
      }
      const consumer = persistence
        ? new URL(
            `fixtures/plugin-persistence/compatibility-consumer.${language === "js" ? "ts" : "py"}`,
            import.meta.url,
          )
        : new URL(`legacy-consumer.${language === "js" ? "ts" : "py"}`, fixture);
      if (language === "js") {
        await build({
          entryPoints: [consumer.pathname],
          outfile: path.join(folder, "main.cjs"),
          bundle: true,
          platform: "node",
          format: "cjs",
          alias: {
            "@kobrixa/plugin-sdk": path.join(sdkRoot, "packages/plugin-sdk-js/src/index.ts"),
            "@kobrixa/plugin-protocol": path.join(sdkRoot, "packages/plugin-protocol/src/index.ts"),
          },
          nodePaths: [
            path.join(root, "packages/plugin-protocol/node_modules"),
            path.join(root, "node_modules"),
          ],
          banner: {
            js: compatibility
              ? `(()=>{const fs=require('node:fs'),crypto=require('node:crypto'),p=require('node:path');const schema=fs.readFileSync(p.join(__dirname,'sdk-schema.json'));console.error('COMPAT_BOOT:'+JSON.stringify({pid:process.pid,schemaId:JSON.parse(schema).$id,schemaSha256:crypto.createHash('sha256').update(schema).digest('hex')}));})();`
              : 'console.error("UI_PID:" + process.pid);',
          },
        });
        artifacts.push(`${slug}/main.cjs`);
      } else {
        await cp(path.join(sdkRoot, "sdks/python/kobrixa"), path.join(folder, "kobrixa"), {
          recursive: true,
          filter: (file) => !file.includes("__pycache__"),
        });
        await writeFile(
          path.join(folder, "consumer.py"),
          (compatibility
            ? 'import os, sys, pathlib, hashlib, json\nschema = pathlib.Path(__file__).with_name("sdk-schema.json").read_bytes()\nprint("COMPAT_BOOT:" + json.dumps(dict(pid=os.getpid(), schemaId=json.loads(schema)["$id"], schemaSha256=hashlib.sha256(schema).hexdigest())), file=sys.stderr, flush=True)\n'
            : 'import os, sys\nprint("UI_PID:" + str(os.getpid()), file=sys.stderr, flush=True)\n') +
            (await readFile(consumer, "utf8")),
        );
        artifacts.push(`${slug}/consumer.py`);
        for (const file of await readdir(path.join(folder, "kobrixa"), {
          withFileTypes: true,
          recursive: true,
        }))
          if (file.isFile())
            artifacts.push(path.relative(directory, path.join(file.parentPath, file.name)));
      }
      sources.push(folder);
      cases.push({
        id,
        sdk: version === "new" ? "current" : sdkVersion,
        ...(compatibility
          ? { slot: options.slot, commit: sha, sourceHashes: hashes, schemaSha256 }
          : {}),
        ui: version === "old-ui",
        language,
      });
    }
  return { sources, python, artifacts, provenance: { sha, hashes, cases } };
}
