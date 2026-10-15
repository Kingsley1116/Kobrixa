import type { PluginNotice } from "@kobrixa/plugin-runtime";
import type { LogLine, LogRead, StoredNotice } from "../../shared/plugins.js";

export const LOG_SOURCE_LIMIT_BYTES = 256 * 1024;
export const LOG_TOTAL_LIMIT_BYTES = 4 * 1024 * 1024;
export const LOG_READ_LIMIT_BYTES = 64 * 1024;
export const NOTICE_SOURCE_LIMIT = 100;

const ESC = 0x1b;
const CSI = 0x9b;

/** Returns the index of the escape sequence's last character. */
function skipEscape(text: string, start: number): number {
  const c1 = text.charCodeAt(start) === CSI;
  const kind = c1 ? 0x5b : text.charCodeAt(start + 1);
  let index = c1 ? start : start + 1;
  if (kind === 0x5b) {
    // CSI: parameter and intermediate bytes, then one final byte.
    while (++index < text.length) {
      const code = text.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index;
    }
    return text.length - 1;
  }
  if (kind === 0x5d) {
    // OSC: ends with BEL or ESC \.
    while (++index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x07) return index;
      if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 1;
    }
    return text.length - 1;
  }
  return Math.min(start + 1, text.length - 1);
}

/**
 * Removes ANSI escape sequences and control characters (tabs stay). A carriage return inside
 * the line starts a new line, so progress output stays readable.
 */
export function cleanLogLine(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ESC || code === CSI) {
      index = skipEscape(text, index);
      continue;
    }
    if (code === 0x0d) {
      lines.push(line);
      line = "";
      continue;
    }
    if (code === 0x09 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f)))
      line += text[index];
  }
  lines.push(line);
  // A CRLF line ending is not an inline carriage return.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

interface SourceLog {
  lines: LogLine[];
  bytes: number;
  /** Sequence number of the newest dropped line. */
  droppedThrough: number;
}
const sizeOf = (text: string) => Buffer.byteLength(text, "utf8") + 1;

/** In-memory plugin output, kept across plugin restarts and never written to disk. */
export class PluginLogs {
  readonly #sources = new Map<string, SourceLog>();
  #total = 0;
  #seq = 0;

  constructor(
    private readonly limits = {
      source: LOG_SOURCE_LIMIT_BYTES,
      total: LOG_TOTAL_LIMIT_BYTES,
      read: LOG_READ_LIMIT_BYTES,
    },
  ) {}

  append(sourceKey: string, text: string): void {
    let log = this.#sources.get(sourceKey);
    if (!log) {
      log = { lines: [], bytes: 0, droppedThrough: 0 };
      this.#sources.set(sourceKey, log);
    }
    for (const clean of cleanLogLine(text)) {
      log.lines.push({ seq: ++this.#seq, text: clean });
      const size = sizeOf(clean);
      log.bytes += size;
      this.#total += size;
    }
    while (log.bytes > this.limits.source) this.#dropOldest(log);
    while (this.#total > this.limits.total) this.#dropOldest(this.#oldest()!);
  }

  read(sourceKey: string, after: number): LogRead {
    const log = this.#sources.get(sourceKey);
    if (!log) return { lines: [], next: after, truncated: false };
    const lines: LogLine[] = [];
    let bytes = 0;
    for (const line of log.lines) {
      if (line.seq <= after) continue;
      bytes += sizeOf(line.text);
      if (lines.length > 0 && bytes > this.limits.read) break;
      lines.push(line);
    }
    return {
      lines,
      next: lines.at(-1)?.seq ?? Math.max(after, log.droppedThrough),
      truncated: log.droppedThrough > after,
    };
  }

  clear(sourceKey: string): void {
    const log = this.#sources.get(sourceKey);
    if (!log) return;
    this.#total -= log.bytes;
    this.#sources.delete(sourceKey);
  }

  #dropOldest(log: SourceLog): void {
    const line = log.lines.shift()!;
    const size = sizeOf(line.text);
    log.bytes -= size;
    this.#total -= size;
    log.droppedThrough = line.seq;
  }

  #oldest(): SourceLog | undefined {
    let oldest: SourceLog | undefined;
    for (const log of this.#sources.values())
      if (log.lines.length && (!oldest || log.lines[0]!.seq < oldest.lines[0]!.seq)) oldest = log;
    return oldest;
  }
}

/** Plugin notices collected in main, so the panel can show them after it was closed. */
export class PluginNotices {
  readonly #sources = new Map<string, StoredNotice[]>();
  #id = 0;

  add(notice: PluginNotice): StoredNotice {
    const stored = { ...notice, id: ++this.#id };
    const list = this.#sources.get(notice.sourceKey) ?? [];
    list.push(stored);
    if (list.length > NOTICE_SOURCE_LIMIT) list.shift();
    this.#sources.set(notice.sourceKey, list);
    return stored;
  }

  /** Newest first. */
  list(): StoredNotice[] {
    return [...this.#sources.values()].flat().sort((a, b) => b.id - a.id);
  }

  clear(sourceKey: string): void {
    this.#sources.delete(sourceKey);
  }
}
