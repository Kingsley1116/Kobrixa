import { MESSAGE_TYPE, type Notice } from "@kobrixa/collab-protocol";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/** `MESSAGE_TYPE.notice` frame: varint type, then the notice as a JSON string. */
export function encodeNotice(notice: Notice): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPE.notice);
  encoding.writeVarString(encoder, JSON.stringify(notice));
  return encoding.toUint8Array(encoder);
}

/** `MESSAGE_TYPE.awareness` frame wrapping a y-protocols awareness update. */
export function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_TYPE.awareness);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export type AwarenessEntry = {
  clientId: number;
  clock: number;
  /** JSON-encoded state; `"null"` marks a removed client. */
  state: string;
};

/** Decodes a y-protocols awareness update (the payload inside an awareness frame). */
export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > 8 || update.byteLength > 64 * 1024) throw new Error("awareness frame too large");
  const entries: AwarenessEntry[] = [];
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = decoding.readVarString(decoder);
    if (state.length > 8192 || !Number.isSafeInteger(clientId) || !Number.isSafeInteger(clock))
      throw new Error("invalid awareness entry");
    entries.push({ clientId, clock, state });
  }
  return entries;
}

/** Encodes awareness entries in the y-protocols awareness update format. */
export function encodeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.state);
  }
  return encoding.toUint8Array(encoder);
}
