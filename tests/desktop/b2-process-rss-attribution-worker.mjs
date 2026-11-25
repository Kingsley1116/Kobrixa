import { BroadcastChannel } from "node:worker_threads";
import { writeHeapSnapshot } from "node:v8";
import { registerHooks } from "node:module";
import { sample } from "./b2-process-rss-attribution-probe.mjs";

// Diagnostic counterfactuals run only in this worker. Match the exact source or fail.
const mode = process.env.W16A_MODE;
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("unmatched attribution hook: " + before);
  return source.replace(before, after);
}
if (["pool", "fresh", "hash", "decoder", "hook-control", "sync-check"].includes(mode))
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const name = url.split("/").pop();
      if (!url.includes("/plugins/persistence/")) return result;
      let source = Buffer.from(result.source).toString();
      if (mode === "sync-check" && name === "filesystem.ts") {
        // Same component walk and predicates, using synchronous syscalls on the worker.
        const start = source.indexOf("  async check(p: StorePath,");
        const end = source.indexOf("  async open(p: StorePath,", start);
        if (start < 0 || end < start) throw new Error("unmatched filesystem check");
        let check = replace(source.slice(start, end), "await lstat(current)", "lstatSync(current)");
        check = replace(check, "await realpath(current)", "realpathSync.native(current)");
        source =
          'import {lstatSync, realpathSync} from "node:fs";\n' +
          source.slice(0, start) +
          check +
          source.slice(end);
      }
      if (mode === "fresh" && name === "namespace.ts") {
        source = replace(
          source,
          "verifyScratch.get(this.fs) ?? new Uint8Array(262144)",
          "new Uint8Array(262144)",
        );
      }
      if (mode === "pool" && name === "worker.ts") {
        source = replace(
          source,
          "f.scratch ??= new Uint8Array(262144);",
          "f.scratch ??= globalThis.w16Scratch ?? new Uint8Array(262144); globalThis.w16Scratch = undefined;",
        );
        source = replace(
          source,
          "if (done && p.transform)",
          "if (done && p.file?.scratch) { globalThis.w16Scratch = p.file.scratch; delete p.file.scratch; } if (done && p.transform)",
        );
      }
      if (mode === "decoder" && name === "stream-json.ts") {
        source = replace(
          source,
          'private readonly decoder = new TextDecoder("utf-8", { fatal: true });',
          'private readonly decoder = w16Decoders.pop() ?? new TextDecoder("utf-8", { fatal: true });',
        );
        source = replace(
          source,
          "const tail = this.decoder.decode();",
          "const tail = this.decoder.decode(); if (!w16Decoders.length) w16Decoders.push(this.decoder);",
        );
        source = "const w16Decoders: TextDecoder[] = [];\n" + source;
      }
      if (mode === "hash" && source.includes('createHash("sha256")')) {
        // A finalized OpenSSL context cannot be reset by Node's Hash API.
        source =
          'const w16Template = createHash("sha256");\n' +
          source.replaceAll('createHash("sha256")', "w16Template.copy()");
      }
      return { ...result, source };
    },
  });
const port = new BroadcastChannel("w16a-" + process.pid);
port.unref();
port.onmessage = async ({ data }) => {
  if (data.allocations) {
    const { allocationSample } = await import("./b2-process-rss-attribution-allocations.mjs");
    port.postMessage((await allocationSample(data.allocations)) ?? null);
    return;
  }
  if (data.gc) globalThis.gc();
  if (data.snapshot) writeHeapSnapshot(data.snapshot);
  port.postMessage(sample());
};
await import("./fixtures/plugin-persistence/stream-import-worker.mjs");
