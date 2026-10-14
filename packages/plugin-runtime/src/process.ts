import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
export interface PluginProcessOptions {
  killGraceMs?: number;
  /** Receives decoded log lines without line endings, including the final partial line on exit. */
  onOutput?(line: string): void;
}

const TAIL_CHARACTERS = 16 * 1024;
export class OutputTail {
  #text = "";
  #ended = false;
  readonly #streams = new Map<"stdout" | "stderr", { decoder: StringDecoder; line: string }>();

  constructor(private readonly onOutput?: (line: string) => void) {}

  push(chunk: Uint8Array | string, stream: "stdout" | "stderr" = "stderr"): void {
    if (this.#ended) return;
    let state = this.#streams.get(stream);
    if (!state) {
      state = { decoder: new StringDecoder("utf8"), line: "" };
      this.#streams.set(stream, state);
    }
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#append(state.decoder.write(bytes), state);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const state of this.#streams.values()) {
      this.#append(state.decoder.end(), state);
      if (state.line) this.#emitOutput(state.line);
      state.line = "";
    }
  }

  #append(text: string, state: { line: string }): void {
    this.#text = (this.#text + text).slice(-TAIL_CHARACTERS);
    if (!this.onOutput) return;
    let offset = 0;
    let newline = text.indexOf("\n");
    while (offset < text.length) {
      const lineEnd = newline < 0 ? text.length : newline;
      let end = Math.min(lineEnd, offset + TAIL_CHARACTERS - state.line.length);
      // Decoded UTF-8 contains complete pairs; keep a pair together at the cap.
      const last = text.charCodeAt(end - 1);
      if (end > offset && last >= 0xd800 && last <= 0xdbff) end--;
      state.line += text.slice(offset, end);
      offset = end;
      if (offset === newline) {
        this.#emitOutput(state.line.endsWith("\r") ? state.line.slice(0, -1) : state.line);
        state.line = "";
        offset++;
        // Search once per newline, not once per capped fragment of a long line.
        newline = text.indexOf("\n", offset);
      } else if (offset < lineEnd) {
        this.#emitOutput(state.line);
        state.line = "";
      }
    }
  }

  #emitOutput(line: string): void {
    try {
      this.onOutput?.(line);
    } catch {
      // Log hooks must not interrupt output draining or exit reporting.
    }
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
  options: PluginProcessOptions = {},
): PluginProcess {
  const decoder = new ContentLengthDecoder();
  const listeners = new Set<(text: string) => void>();
  const tail = new OutputTail(options.onOutput);
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
    let messages: string[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      framing = `Plugin wrote non-protocol data to stdout (${error instanceof Error ? error.message : String(error)}). Write logs to stderr.`;
      kill();
      return;
    }
    for (const text of messages) for (const listener of listeners) listener(text);
  });
  child.stderr.on("data", (chunk: Buffer) => tail.push(chunk));
  child.stdin.on("error", () => {
    /* EPIPE after the plugin exits is reported through the exit event. */
  });
  // A PID also identifies a child wrapped after its spawn event already fired.
  let spawned = child.pid !== undefined;
  child.once("spawn", () => {
    spawned = true;
  });
  child.on("error", (error) => {
    if (!spawned) {
      tail.end();
      exits.emit({ code: null, reason: error.message });
    }
  });
  child.once("exit", (code, signal) => {
    // Exit can precede the final stdout/stderr data; bound the wait for their EOFs.
    const emitExit = () => {
      clearTimeout(timer);
      child.stdout.off("end", onEnd);
      child.stderr.off("end", onEnd);
      tail.end();
      exits.emit({
        code,
        ...(framing ? { reason: framing } : signal ? { reason: `terminated by ${signal}` } : {}),
      });
    };
    const onEnd = () => {
      if (child.stdout.readableEnded && child.stderr.readableEnded) emitExit();
    };
    const timer = setTimeout(emitExit, 100);
    child.stdout.once("end", onEnd);
    child.stderr.once("end", onEnd);
    onEnd();
  });
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
  options: { cwd: string; env?: NodeJS.ProcessEnv } & PluginProcessOptions,
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
      resolve(stdioProcess(child, options));
    });
  });
}
