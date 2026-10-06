import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeIR, validateIR } from "@kobrixa/ir";
import type {
  BuildArtifact,
  BuildProgress,
  CompileResult,
  CompilerBackend,
  LanguageFrontend,
  SourceProject,
} from "./contracts.js";
import { diagnostic, diagnosticFromSpan } from "./diagnostics.js";

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function fileName(name: string): string {
  const safe = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "program";
}

export class BuildSession {
  readonly id = randomUUID();
  readonly #controller: AbortController;
  readonly #onProgress: ((progress: BuildProgress) => void) | undefined;
  #started = false;

  constructor(
    readonly frontend: LanguageFrontend,
    readonly backend: CompilerBackend,
    onProgress?: (progress: BuildProgress) => void,
    controller = new AbortController(),
  ) {
    this.#onProgress = onProgress;
    this.#controller = controller;
  }

  cancel(): void {
    this.#controller.abort();
  }

  async compile(project: SourceProject): Promise<CompileResult> {
    if (this.#started) throw new Error("A build session can only compile once.");
    this.#started = true;
    const diagnostics = [];
    const artifacts: BuildArtifact[] = [];
    const outputDir = path.join(project.root, project.manifest.outputDir);
    const stagingDir = path.join(outputDir, `.kobrixa-${this.id}.tmp`);
    try {
      this.#progress("frontend", "Compiling Basic Plus sources");
      this.#throwIfCancelled();
      const frontend = await this.frontend.compile(project, this.#controller.signal);
      diagnostics.push(...frontend.diagnostics);
      if (!frontend.ir || diagnostics.some((item) => item.severity === "error")) {
        return { success: false, diagnostics, artifacts };
      }

      this.#progress("ir", "Validating KobrixaIR");
      const issues = validateIR(frontend.ir);
      diagnostics.push(
        ...issues.map((item) => diagnosticFromSpan(item.code, item.message, item.span)),
      );
      if (issues.length) return { success: false, diagnostics, artifacts };

      this.#progress("backend", "Generating native EV3 bytecode");
      const backend = await this.backend.compile(frontend.ir, this.#controller.signal);
      diagnostics.push(...backend.diagnostics);
      if (!backend.rbf || diagnostics.some((item) => item.severity === "error")) {
        return { success: false, diagnostics, artifacts };
      }

      this.#throwIfCancelled();
      this.#progress("commit", "Committing verified artifacts");
      await mkdir(stagingDir, { recursive: true });
      const base = fileName(project.manifest.name);
      const stagedRbf = path.join(stagingDir, `${base}.rbf`);
      const stagedIr = path.join(stagingDir, `${base}.ir.json`);
      const stagedListing = path.join(stagingDir, `${base}.lst`);
      const irText = serializeIR(frontend.ir);
      await writeFile(stagedRbf, backend.rbf);
      await writeFile(stagedIr, irText, "utf8");
      if (backend.listing) await writeFile(stagedListing, backend.listing, "utf8");
      this.#throwIfCancelled();

      const entries: Array<{
        kind: BuildArtifact["kind"];
        staged: string;
        data: string | Uint8Array;
      }> = [
        { kind: "rbf", staged: stagedRbf, data: backend.rbf },
        { kind: "ir", staged: stagedIr, data: irText },
      ];
      if (backend.listing)
        entries.push({ kind: "listing", staged: stagedListing, data: backend.listing });
      for (const entry of entries) {
        const destination = path.join(outputDir, path.basename(entry.staged));
        await rename(entry.staged, destination);
        artifacts.push({ kind: entry.kind, path: destination, sha256: sha256(entry.data) });
      }
      for (const asset of project.assets) {
        this.#throwIfCancelled();
        const relative = asset.path.replaceAll("\\", "/");
        const staged = path.join(stagingDir, "assets", relative);
        const destination = path.join(outputDir, "assets", relative);
        await mkdir(path.dirname(staged), { recursive: true });
        await copyFile(asset.absolutePath, staged);
        await mkdir(path.dirname(destination), { recursive: true });
        await rename(staged, destination);
        const data = await readFile(destination);
        artifacts.push({
          kind: "asset",
          path: destination,
          sha256: sha256(data),
          remotePath: relative,
        });
      }
      this.#progress("complete", "Build complete");
      return {
        success: true,
        diagnostics,
        artifacts,
        ...(frontend.ir.program.runtimeDirectory
          ? { runtimeDirectory: frontend.ir.program.runtimeDirectory }
          : {}),
      };
    } catch (error) {
      const cancelled =
        this.#controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      diagnostics.push(
        diagnostic(
          cancelled ? "BUILD0001" : "BUILD9000",
          cancelled
            ? "Build cancelled."
            : error instanceof Error
              ? error.message
              : "Internal build failure.",
          project.manifest.entry,
        ),
      );
      return { success: false, diagnostics, artifacts: [] };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  #throwIfCancelled(): void {
    this.#controller.signal.throwIfAborted();
  }

  #progress(stage: BuildProgress["stage"], message: string): void {
    this.#onProgress?.({ buildId: this.id, stage, message });
  }
}
