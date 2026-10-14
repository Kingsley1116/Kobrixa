import { PLUGIN_LIMITS } from "./limits.js";

export class FramingError extends Error {
  constructor(
    readonly code: "PLUGIN_E_FRAME_HEADER" | "PLUGIN_E_FRAME_SIZE" | "PLUGIN_E_FRAME_UTF8",
    message: string,
  ) {
    super(message);
    this.name = "FramingError";
  }
}

const encoder = new TextEncoder();

export function encodeContentLength(text: string): Uint8Array {
  const body = encoder.encode(text);
  if (body.length > PLUGIN_LIMITS.messageBytes)
    throw new FramingError("PLUGIN_E_FRAME_SIZE", "Message exceeds 1 MiB.");
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header);
  frame.set(body, header.length);
  return frame;
}

function headerEnd(buffer: Uint8Array): number {
  for (let index = 0; index + 3 < buffer.length; index++)
    if (
      buffer[index] === 13 &&
      buffer[index + 1] === 10 &&
      buffer[index + 2] === 13 &&
      buffer[index + 3] === 10
    )
      return index;
  return -1;
}

const HEADER_LINE = /^[A-Za-z0-9-]+:[^\r]*$/;

/** Rejects stray output such as a single print() line before a header terminator arrives. */
function assertHeaderPrefix(buffer: Uint8Array): void {
  const lines = new TextDecoder("latin1").decode(buffer).split("\n");
  lines.pop(); // The last line may still be arriving.
  for (const line of lines)
    if (!line.endsWith("\r") || !HEADER_LINE.test(line.slice(0, -1)))
      throw new FramingError("PLUGIN_E_FRAME_HEADER", "Malformed message header.");
}

export class ContentLengthDecoder {
  #buffer = new Uint8Array(0);
  readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
  constructor(private readonly maxBytes: number = PLUGIN_LIMITS.messageBytes) {}

  push(chunk: Uint8Array): string[] {
    const merged = new Uint8Array(this.#buffer.length + chunk.length);
    merged.set(this.#buffer);
    merged.set(chunk, this.#buffer.length);
    this.#buffer = merged;
    const messages: string[] = [];
    for (;;) {
      const end = headerEnd(this.#buffer);
      if (
        end < 0 ? this.#buffer.length > PLUGIN_LIMITS.headerBytes : end > PLUGIN_LIMITS.headerBytes
      )
        throw new FramingError("PLUGIN_E_FRAME_HEADER", "Message header is too long.");
      if (end < 0) {
        assertHeaderPrefix(this.#buffer);
        return messages;
      }
      let length: number | undefined;
      for (const line of new TextDecoder("latin1")
        .decode(this.#buffer.subarray(0, end))
        .split("\r\n")) {
        const match = /^content-length:[ \t]*([0-9]{1,10})[ \t]*$/i.exec(line);
        if (match) {
          if (length !== undefined)
            throw new FramingError("PLUGIN_E_FRAME_HEADER", "Duplicate Content-Length.");
          length = Number(match[1]);
        } else if (!HEADER_LINE.test(line))
          throw new FramingError("PLUGIN_E_FRAME_HEADER", "Malformed message header.");
      }
      if (length === undefined)
        throw new FramingError("PLUGIN_E_FRAME_HEADER", "Missing Content-Length.");
      if (length > this.maxBytes)
        throw new FramingError("PLUGIN_E_FRAME_SIZE", "Message exceeds 1 MiB.");
      const start = end + 4;
      if (this.#buffer.length < start + length) return messages;
      try {
        messages.push(this.#utf8.decode(this.#buffer.subarray(start, start + length)));
      } catch {
        throw new FramingError("PLUGIN_E_FRAME_UTF8", "Message body is not valid UTF-8.");
      }
      this.#buffer = this.#buffer.slice(start + length);
    }
  }
}
