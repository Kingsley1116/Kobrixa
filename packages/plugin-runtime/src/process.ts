import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ContentLengthDecoder,
  encodeContentLength,
  type MessageChannelLike,
} from "@kobrixa/plugin-protocol";

export interface ProcessExit {
  code: number | null;
  reason?: string;
}
export interface PluginProcess extends MessageChannelLike {
  onExit(listener: (exit: ProcessExit) => void): () => void;
  kill(): void;
  /** Terminates immediately; used when an overall shutdown deadline is reached. */
  forceKill(): void;
  stderrTail(): string;
}

const TAIL_CHARACTERS = 16 * 1024;
export class OutputTail {
  #text = "";
  push(chunk: Uint8Array | string): void {
    this.#text = (
      this.#text + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    ).slice(-TAIL_CHARACTERS);
  }
  text(): string {
    return this.#text;
  }
}

export class ExitSignal {
  #exit: ProcessExit | undefined;
  readonly #listeners = new Set<(exit: ProcessExit) => void>();
  get exited(): boolean {
    return this.#exit !== undefined;
  }
  emit(exit: ProcessExit): void {
    if (this.#exit) return;
    this.#exit = exit;
    for (const listener of this.#listeners) listener(exit);
    this.#listeners.clear();
  }
  subscribe(listener: (exit: ProcessExit) => void): () => void {
    const exit = this.#exit;
    if (exit) {
      queueMicrotask(() => listener(exit));
      return () => {};
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export const DEFAULT_KILL_GRACE_MS = 2_000;

/** Asks for a graceful exit, then forces termination if the process ignores it. */
export function escalatingKill(
  exits: ExitSignal,
  graceful: () => void,
  forced: () => void,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): { kill(): void; forceKill(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forcedOnce = false;
  exits.subscribe(() => clearTimeout(timer));
  const forceKill = () => {
    if (exits.exited || forcedOnce) return;
    forcedOnce = true;
    clearTimeout(timer);
    forced();
  };
  return {
    kill: () => {
      if (exits.exited || timer || forcedOnce) return;
      graceful();
      timer = setTimeout(forceKill, graceMs);
    },
    forceKill,
  };
}

export function stdioProcess(
  child: ChildProcessWithoutNullStreams,
  options: { killGraceMs?: number } = {},
): PluginProcess {
  const decoder = new ContentLengthDecoder();
  const listeners = new Set<(text: string) => void>();
  const tail = new OutputTail();
  const exits = new ExitSignal();
  // On Windows both signals map to TerminateProcess; on POSIX SIGKILL cannot be ignored.
  const { kill, forceKill } = escalatingKill(
    exits,
    () => child.kill("SIGTERM"),
    () => child.kill("SIGKILL"),
    options.killGraceMs,
  );
  let framing: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => {
    if (framing) return;
    try {
      for (const text of decoder.push(chunk)) for (const listener of listeners) listener(text);
    } catch (error) {
      framing = `Plugin wrote non-protocol data to stdout (${error instanceof Error ? error.message : String(error)}). Write logs to stderr.`;
      kill();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stdin.on("error", () => {
    /* EPIPE after the plugin exits is reported through the exit event. */
  });
  child.once("error", (error) => exits.emit({ code: null, reason: error.message }));
  child.once("exit", (code, signal) =>
    exits.emit({
      code,
      ...(framing ? { reason: framing } : signal ? { reason: `terminated by ${signal}` } : {}),
    }),
  );
  return {
    send: (text) => {
      if (!child.stdin.writable) throw new Error("The plugin process is not accepting input.");
      child.stdin.write(encodeContentLength(text));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: (listener) => exits.subscribe(listener),
    kill,
    forceKill,
    stderrTail: () => tail.text(),
  };
}

export function spawnPluginProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; killGraceMs?: number },
): Promise<PluginProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: "pipe",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.off("error", reject);
      resolve(
        stdioProcess(
          child,
          options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs },
        ),
      );
    });
  });
}
