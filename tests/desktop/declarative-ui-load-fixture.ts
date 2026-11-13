import type { UiCatalogEntry } from "@kobrixa/plugin-protocol";

/** Timers can wake early; the orphan observation requires elapsed time, not a
 * requested timeout. Return the measured interval without rounding it up. */
export async function waitLoadInterval(
  milliseconds: number,
  options: { now?: () => number; pause?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  let elapsed = now() - start;
  while (elapsed < milliseconds) {
    await pause(Math.ceil(milliseconds - elapsed));
    elapsed = now() - start;
  }
  return elapsed;
}

/** The native load shell uses the static builtin base, with no shipped feature UI.
 * Reject extra/replaced contributions rather than counting them as fixture load. */
export function assertLoadCatalog(entries: readonly UiCatalogEntry[]): void {
  const expected = new Set(
    Array.from({ length: 8 }, (_, n) =>
      ["panel", "status"].flatMap((kind) => [0, 1].map((i) => `acceptance.ui-${n}.${kind}-${i}`)),
    ).flat(),
  );
  const sources = new Map<string, string>();
  for (const entry of entries) {
    if (
      !expected.delete(entry.id) ||
      !entry.id.startsWith(`${entry.pluginId}.${entry.kind}-`) ||
      entry.availability !== "available" ||
      entry.version !== 1 ||
      entry.resourceBytes !== 256 * 1024 ||
      !entry.sourceKey.startsWith("dev:") ||
      (sources.has(entry.pluginId) && sources.get(entry.pluginId) !== entry.sourceKey)
    )
      throw new Error(`Unexpected load contribution: ${JSON.stringify(entry)}`);
    sources.set(entry.pluginId, entry.sourceKey);
  }
  if (expected.size || sources.size !== 8 || new Set(sources.values()).size !== 8)
    throw new Error(`Incomplete load fixture: missing ${[...expected].join(", ")}`);
}

/** Setup synchronization only; measurement budgets and thresholds stay unchanged. */
export async function waitForLoad<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  label: string,
  options: { now?: () => number; pause?: () => Promise<void>; timeoutMs?: number } = {},
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const deadline = now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (now() >= deadline)
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await pause();
  }
}

/** Evaluate and settle inside the renderer. Only a JSON string crosses Electron
 * IPC, including failures; Error instances must not become IPC payloads. */
export function loadEvaluation(source: string): string {
  return `(async () => {
    const errorData = (error) => ({
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error),
      stack: typeof error?.stack === "string" ? error.stack : "",
    });
    try {
      const value = await (${source});
      return JSON.stringify({ ok: true, value: value ?? null },
        (_key, item) => item instanceof Error ? errorData(item) : item);
    } catch (error) {
      return JSON.stringify({ ok: false, error: errorData(error) });
    }
  })()`;
}

export function loadResult<T = unknown>(json: string): T {
  const result = JSON.parse(json);
  if (!result.ok) {
    const error = new Error(result.error.message);
    error.name = result.error.name;
    error.stack = result.error.stack;
    throw error;
  }
  return result.value as T;
}

/** Truthiness must be projected before IPC, never after cloning a harness API
 * (functions/promises) or a DOM element. */
export function loadReadiness(source: string): string {
  return `Boolean(${source})`;
}
