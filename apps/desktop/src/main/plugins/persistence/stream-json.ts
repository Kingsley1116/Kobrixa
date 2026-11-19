import { isAscii } from "node:buffer";

enum State {
  Value,
  FirstValue,
  FirstKey,
  Key,
  Colon,
  After,
  String,
  Escape,
  Unicode,
  Literal,
  Minus,
  Zero,
  Integer,
  Point,
  Fraction,
  Exponent,
  Sign,
  ExponentDigits,
}
function invalid(): never {
  throw new Error("invalid-resource");
}
function digit(c: number) {
  return c >= 48 && c <= 57;
}
function space(c: number) {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

// State spans input chunks. The only unbounded grammar dimension, nesting,
// uses one bit per level. Ordinary scalar tokens never need a token buffer.
export class JsonFormatReader {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private asciiBoundary = false;
  private state = State.Value;
  private stack = new Uint8Array(16);
  private depth = 0;
  private version: number | undefined;
  private versionValue = false;
  private key = false;
  private keyIndex = -1;
  private hexDigits = 0;
  private unicode = 0;
  private literal = "";
  private literalIndex = 0;
  private negative = false;
  private significant = "";
  private fraction = 0;
  private omitted = 0;
  private sticky = false;
  private exponent = 0;
  private exponentNegative = false;

  constructor(private readonly versionKey: string) {}

  update(bytes: Uint8Array) {
    if (!bytes.length) return;
    if (this.asciiBoundary && isAscii(bytes)) this.scan(bytes);
    else {
      const text = this.decoder.decode(bytes, { stream: true });
      this.asciiBoundary = bytes[bytes.length - 1]! < 128;
      // Leave BOM handling, split UTF-8 sequences and surrogate pairs to TextDecoder.
      const units = new Uint16Array(text.length);
      for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
      this.scan(units);
    }
  }
  private keyChar(c: number) {
    if (this.keyIndex >= 0) {
      if (c === this.versionKey.charCodeAt(this.keyIndex)) this.keyIndex++;
      else this.keyIndex = -1;
    }
  }
  private mantissaDigit(c: number) {
    if (!this.significant && c === 48) return;
    // Binary64 rounding boundaries have fewer than 1100 significant decimal digits.
    if (this.significant.length < 1100) this.significant += String.fromCharCode(c);
    else {
      this.omitted++;
      if (c !== 48) this.sticky = true;
    }
  }
  private endNumber() {
    if (this.versionValue) {
      const exp = this.exponentNegative ? -this.exponent : this.exponent;
      this.version = Number(
        (this.negative ? "-" : "") +
          (this.significant || "0") +
          (this.sticky ? "1" : "") +
          "e" +
          (exp - this.fraction + this.omitted - Number(this.sticky)),
      );
      this.versionValue = false;
    }
    this.state = State.After;
  }
  private scan(units: Uint8Array | Uint16Array) {
    let i = 0;
    while (i < units.length) {
      const c = units[i]!;
      switch (this.state) {
        case State.String:
          while (i < units.length) {
            const u = units[i++]!;
            if (u === 34) {
              if (this.key) this.versionValue = this.keyIndex === this.versionKey.length;
              this.state = this.key ? State.Colon : State.After;
              break;
            }
            if (u === 92) {
              this.state = State.Escape;
              break;
            }
            if (u < 32) invalid();
            if (this.keyIndex >= 0) this.keyChar(u);
          }
          continue;
        case State.Escape:
          i++;
          if (c === 117) {
            this.unicode = 0;
            this.hexDigits = 0;
            this.state = State.Unicode;
            continue;
          }
          switch (c) {
            case 34:
            case 47:
            case 92:
              this.keyChar(c);
              break;
            case 98:
              this.keyChar(8);
              break;
            case 102:
              this.keyChar(12);
              break;
            case 110:
              this.keyChar(10);
              break;
            case 114:
              this.keyChar(13);
              break;
            case 116:
              this.keyChar(9);
              break;
            default:
              invalid();
          }
          this.state = State.String;
          continue;
        case State.Unicode: {
          const hex = digit(c)
            ? c - 48
            : (c | 32) >= 97 && (c | 32) <= 102
              ? (c | 32) - 87
              : invalid();
          this.unicode = this.unicode * 16 + hex;
          i++;
          if (++this.hexDigits === 4) {
            this.keyChar(this.unicode);
            this.state = State.String;
          }
          continue;
        }
        case State.Literal:
          while (i < units.length && this.literalIndex < this.literal.length)
            if (units[i++] !== this.literal.charCodeAt(this.literalIndex++)) invalid();
          if (this.literalIndex === this.literal.length) this.state = State.After;
          continue;
        case State.Minus:
          if (!digit(c)) invalid();
          this.state = c === 48 ? State.Zero : State.Integer;
          if (this.versionValue) this.mantissaDigit(c);
          i++;
          continue;
        case State.Point:
        case State.Sign:
        case State.Exponent:
          if (this.state === State.Exponent && (c === 43 || c === 45)) {
            this.exponentNegative = c === 45;
            this.state = State.Sign;
            i++;
            continue;
          }
          if (!digit(c)) invalid();
          this.state = this.state === State.Point ? State.Fraction : State.ExponentDigits;
          continue;
        case State.Zero:
        case State.Integer:
        case State.Fraction:
        case State.ExponentDigits:
          if (this.state !== State.Zero && digit(c)) {
            do {
              const n = units[i++]!;
              if (this.versionValue) {
                if (this.state === State.ExponentDigits)
                  this.exponent = Math.min(100000000, this.exponent * 10 + n - 48);
                else {
                  this.mantissaDigit(n);
                  if (this.state === State.Fraction) this.fraction++;
                }
              }
            } while (i < units.length && digit(units[i]!));
            continue;
          }
          if (c === 46 && (this.state === State.Zero || this.state === State.Integer)) {
            this.state = State.Point;
            i++;
            continue;
          }
          if ((c === 101 || c === 69) && this.state !== State.ExponentDigits) {
            this.state = State.Exponent;
            i++;
            continue;
          }
          this.endNumber();
          continue;
      }
      if (space(c)) {
        do {
          i++;
        } while (i < units.length && space(units[i]!));
        continue;
      }
      const index = (this.depth - 1) >> 3,
        mask = 1 << ((this.depth - 1) & 7);
      const object = this.depth > 0 && !!(this.stack[index]! & mask);
      if (
        this.depth &&
        (this.state === State.After ||
          this.state === State.FirstKey ||
          this.state === State.FirstValue) &&
        c === (object ? 125 : 93)
      ) {
        this.depth--;
        this.state = State.After;
        i++;
        continue;
      }
      if (this.state === State.After) {
        if (!this.depth || c !== 44) invalid();
        this.state = object ? State.Key : State.Value;
        i++;
        continue;
      }
      if (this.state === State.Colon) {
        if (c !== 58) invalid();
        this.state = State.Value;
        i++;
        continue;
      }
      // Consume a run of complete one-digit array elements and their delimiters.
      // Leave the last value (and any token split across chunks) to the ordinary states.
      if (
        !object &&
        this.depth &&
        (this.state === State.Value || this.state === State.FirstValue) &&
        digit(c) &&
        units[i + 1] === 44
      ) {
        do {
          i += 2;
        } while (i + 1 < units.length && digit(units[i]!) && units[i + 1] === 44);
        this.state = State.Value;
        continue;
      }
      this.key = this.state === State.Key || this.state === State.FirstKey;
      if (this.key && c !== 34) invalid();
      if (this.versionValue) {
        this.version = undefined;
        if (c === 45 || digit(c)) {
          this.significant = "";
          this.fraction = this.omitted = this.exponent = 0;
          this.sticky = this.exponentNegative = false;
          this.negative = c === 45;
        } else this.versionValue = false;
      }
      i++;
      if (c === 34) {
        this.keyIndex = this.key && this.depth === 1 ? 0 : -1;
        this.state = State.String;
        continue;
      }
      if (c === 91 || c === 123) {
        const n = this.depth >> 3,
          bit = 1 << (this.depth & 7);
        if (n === this.stack.length) {
          const grown = new Uint8Array(n * 2);
          grown.set(this.stack);
          this.stack = grown;
        }
        this.stack[n] = c === 123 ? this.stack[n]! | bit : this.stack[n]! & ~bit;
        this.depth++;
        this.state = c === 123 ? State.FirstKey : State.FirstValue;
        continue;
      }
      if (c === 45) {
        this.state = State.Minus;
        continue;
      }
      if (digit(c)) {
        this.state = c === 48 ? State.Zero : State.Integer;
        if (this.versionValue) this.mantissaDigit(c);
        continue;
      }
      this.literal = c === 116 ? "true" : c === 102 ? "false" : c === 110 ? "null" : invalid();
      this.literalIndex = 1;
      this.state = State.Literal;
    }
  }
  finish() {
    this.decoder.decode();
    if ([State.Zero, State.Integer, State.Fraction, State.ExponentDigits].includes(this.state))
      this.endNumber();
    if (this.depth || this.state !== State.After) invalid();
    return this.version;
  }
}
