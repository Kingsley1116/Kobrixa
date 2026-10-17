import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class SourceReadBudget {
  #remainingMs: number;
  #startedAt: number | undefined;
  #expired = false;
  constructor(
    timeoutMs = 5000,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#remainingMs = timeoutMs;
  }
  check(): void {
    const elapsed = this.#startedAt === undefined ? 0 : this.now() - this.#startedAt;
    if (this.#expired || elapsed >= this.#remainingMs) {
      this.#expired = true;
      throw new Error("Source I/O deadline exceeded.");
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    // Metadata wraps the packaged reader. Nested calls share the outer timer and
    // elapsed interval; they neither double-charge elapsed time nor reset the allowance.
    if (this.#startedAt !== undefined) {
      const value = await work();
      this.check();
      return value;
    }
    this.#startedAt = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.#expired = true;
          reject(new Error("Source I/O deadline exceeded."));
        }, this.#remainingMs);
      });
      const pending = Promise.resolve()
        .then(work)
        .then((value) => {
          this.check();
          return value;
        });
      return await Promise.race([pending, timeout]);
    } finally {
      this.#remainingMs = Math.max(0, this.#remainingMs - (this.now() - this.#startedAt));
      this.#startedAt = undefined;
      clearTimeout(timer);
    }
  }
}

export class PackagedResourceError extends Error {
  constructor(
    message: string,
    readonly limit?: "resourceFileBytes",
    readonly allowed?: number,
    readonly actual?: number,
  ) {
    super(message);
  }
}
export type PackagedJson = { value: unknown; bytes: number; digest: string };
const resourcePath =
  /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\/){0,7}[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.json$/;
function checkPath(file: string): void {
  if (file.length > 600 || !resourcePath.test(file)) throw new Error("Invalid packaged JSON path.");
}
function decode(bytes: Uint8Array): PackagedJson {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  return {
    value: JSON.parse(text) as unknown,
    bytes: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function readBuiltinJson(
  resources: Readonly<Record<string, string>>,
  file: string,
  limit: number,
): PackagedJson {
  checkPath(file);
  if (!Object.hasOwn(resources, file)) throw new Error("Missing bundled resource.");
  const raw = resources[file]!;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > limit)
    throw new PackagedResourceError(
      "Resource file exceeds byte limit.",
      "resourceFileBytes",
      limit,
      bytes,
    );
  return decode(Buffer.from(raw, "utf8"));
}

export async function readPackagedJson(
  root: string,
  file: string,
  limit: number,
  budget: SourceReadBudget,
  deps: { stat: (file: string) => Promise<{ isFile(): boolean }> } = { stat },
): Promise<PackagedJson> {
  checkPath(file);
  return budget.run(async () => {
    const base = await realpath(root);
    budget.check();
    const target = await realpath(path.resolve(base, file));
    budget.check();
    const relative = path.relative(base, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Resource resolves outside the plugin folder.");
    if (!(await deps.stat(target)).isFile()) throw new Error("Resource is not a regular file.");
    budget.check();
    const handle = await open(target, "r");
    try {
      // The finally also closes an open() that completes after the caller's deadline.
      budget.check();
      if (!(await handle.stat()).isFile())
        throw new Error("Opened resource is not a regular file.");
      budget.check();
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        budget.check();
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit)
        throw new PackagedResourceError(
          "Resource file exceeds byte limit.",
          "resourceFileBytes",
          limit,
          length,
        );
      return decode(buffer.subarray(0, length));
    } finally {
      await handle.close();
    }
  });
}
