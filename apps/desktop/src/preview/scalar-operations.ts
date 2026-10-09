import type { PreviewValue } from "./virtual-device.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const MAX_PREVIEW_STRING_BYTES = 251;

export function numeric(value: PreviewValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return Number(value);
  throw new Error("Expected a numeric value.");
}

/** The backend uses EV3's single-precision %g conversion for text arguments. */
export function previewText(value: PreviewValue | undefined): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    const number = Math.fround(value);
    if (!Number.isFinite(number)) return String(number);
    const rounded = Number(number.toPrecision(6));
    if (rounded !== 0 && (Math.abs(rounded) < 0.0001 || Math.abs(rounded) >= 1e6))
      return rounded.toExponential().replace(/e([+-])(\d)$/, "e$10$2");
    return String(rounded);
  }
  throw new Error("An array cannot be converted to text.");
}

export function checkedText(value: string): string {
  const text = value.split("\0", 1)[0]!;
  if (encoder.encode(text).length > MAX_PREVIEW_STRING_BYTES)
    throw new Error(`Text exceeds the EV3 limit of ${MAX_PREVIEW_STRING_BYTES} bytes.`);
  return text;
}

/** Undefined means this is not a scalar intrinsic. Randomness is supplied by the runtime. */
export function scalarOperation(
  operation: string,
  args: PreviewValue[],
  random: () => number,
): PreviewValue | undefined {
  const name = operation.toLowerCase();
  const n = (index: number) => numeric(args[index]);
  const f = (index: number) => Math.fround(n(index));
  const s = (index: number) => previewText(args[index]);
  const byte = (index: number) => Math.trunc(n(index)) & 255;
  const unaryMath: Record<string, (value: number) => number> = {
    abs: Math.abs,
    ceiling: Math.ceil,
    floor: Math.floor,
    naturallog: Math.log,
    log: Math.log10,
    cos: Math.cos,
    sin: Math.sin,
    tan: Math.tan,
    arcsin: Math.asin,
    arccos: Math.acos,
    arctan: Math.atan,
    squareroot: Math.sqrt,
    round: (value) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5),
    doubletodecimal: (value) => value,
    getdegrees: (value) => value * Math.fround(180 / Math.PI),
    getradians: (value) => value * Math.fround(Math.PI / 180),
  };
  if (name.startsWith("math.")) {
    const method = name.slice(5);
    if (unaryMath[method]) return Math.fround(unaryMath[method](f(0)));
    switch (method) {
      case "pi":
        return Math.fround(Math.PI);
      case "power":
        return Math.fround(f(0) ** f(1));
      case "remainder":
        return Math.fround(f(0) % f(1));
      case "max":
        return Math.max(f(0), f(1));
      case "min":
        return Math.min(f(0), f(1));
      case "getrandomnumber": {
        const bound = (Math.trunc(n(0)) << 16) >> 16;
        if (bound < 1) throw new Error("Math.GetRandomNumber requires a positive 16-bit bound.");
        return 1 + Math.floor(random() * bound);
      }
    }
  }
  switch (name) {
    case "byte.not":
      return ~byte(0) & 255;
    case "byte.and_":
      return byte(0) & byte(1);
    case "byte.or_":
      return byte(0) | byte(1);
    case "byte.xor":
      return byte(0) ^ byte(1);
    case "byte.bit":
      return (byte(0) >> (Math.trunc(n(1)) & 7)) & 1;
    case "byte.shl":
      return Math.trunc(Math.fround(byte(0) * Math.fround(2 ** f(1))) % 256);
    case "byte.shr":
      return Math.floor(Math.fround(byte(0) / Math.fround(2 ** f(1))));
    case "byte.tologic":
      return n(0) > 0;
    case "byte.l":
      return Number(s(0).toUpperCase() === "TRUE");
    case "byte.h":
    case "byte.b": {
      const radix = name === "byte.h" ? 16 : 2;
      let result = 0;
      for (const character of s(0)) {
        if (!(radix === 16 ? /^[\da-f]$/i : /^[01]$/).test(character)) continue;
        result = (result * radix + Number.parseInt(character, radix)) & 255;
      }
      return result;
    }
    case "byte.tohex":
      return byte(0).toString(16).toUpperCase().padStart(2, "0");
    case "byte.tobinary":
      return byte(0).toString(2).padStart(8, "0");
    case "text.append":
      return checkedText(s(0) + s(1));
    case "text.getlength":
      return encoder.encode(s(0)).length;
    case "text.getcharacter": {
      const code = byte(0);
      return code === 0 ? "" : decoder.decode(Uint8Array.of(code));
    }
    case "text.getcharactercode":
      return ((encoder.encode(s(0))[0] ?? 0) << 24) >> 24;
    case "text.issubtext":
      return s(1).length > 0 && s(0).includes(s(1));
    case "text.startswith":
      return s(1).length > 0 && s(0).startsWith(s(1));
    case "text.endswith":
      return s(1).length > 0 && s(0).endsWith(s(1));
    case "text.getindexof": {
      const index = s(1).length ? s(0).indexOf(s(1)) : -1;
      return index < 0 ? 0 : encoder.encode(s(0).slice(0, index)).length + 1;
    }
    case "text.getsubtext":
    case "text.getsubtexttoend": {
      const start = Math.trunc(n(1)) - 1;
      const bytes = encoder.encode(s(0));
      const length = name === "text.getsubtext" ? Math.trunc(n(2)) : bytes.length;
      if (start < 0 || start >= bytes.length || length <= 0) return "";
      return decoder.decode(bytes.slice(start, start + length));
    }
    case "text.converttolowercase":
      return s(0).replace(/[A-Z]/g, (value) => value.toLowerCase());
    case "text.converttouppercase":
      return s(0).replace(/[a-z]/g, (value) => value.toUpperCase());
    case "ev3file.converttonumber":
      return Math.fround(Number.parseFloat(s(0)));
  }
  return undefined;
}
