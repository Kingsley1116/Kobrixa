"""Unpublished UI v2 canonical JSON primitive; no RPC or resource admission.

Callers must first validate typed dataset content and rebuild its object keys in
contract order. This module supplies ECMAScript binary64 number formatting and
UTF-8 JSON escaping, not sorting, hashing, schema validation or authority checks.
"""
import json
import math


def _number(value: float | int) -> str:
    try:
        n = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError("UI data number is outside binary64") from error
    if not math.isfinite(n):
        raise ValueError("UI data number must be finite")
    if isinstance(value, int) and n != value:
        raise ValueError("UI data integer is not exactly representable as binary64")
    if n == 0:
        return "0"
    negative = n < 0
    raw = repr(abs(n)).lower()
    mantissa, _, exponent = raw.partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = whole + fraction
    position = len(whole) + int(exponent or "0")
    leading = len(digits) - len(digits.lstrip("0"))
    digits = digits.lstrip("0").rstrip("0")
    position -= leading
    if 0 < position <= 21:
        if len(digits) <= position:
            result = digits + "0" * (position - len(digits))
        else:
            result = digits[:position] + "." + digits[position:]
    elif -6 < position <= 0:
        result = "0." + "0" * -position + digits
    else:
        exp = position - 1
        result = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
        result += "e" + ("+" if exp >= 0 else "-") + str(abs(exp))
    return ("-" if negative else "") + result


def canonical_json_bytes(value) -> bytes:
    """Encode an already normalized JSON tree in its existing contract key order.

    Python-only non-JSON containers, cycles, non-string keys, unsafe object keys,
    unpaired surrogates and nonfinite/lossy numbers are rejected. Booleans remain
    booleans rather than Python integer subclasses. Dataset admission separately
    rejects NUL and applies scalar/entry/aggregate bounds.
    """
    active = set()

    def string(text):
        if any(0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError("Unpaired surrogate")
        return json.dumps(text, ensure_ascii=False, separators=(",", ":"))

    def encode(item):
        if item is None:
            return "null"
        if type(item) is bool:
            return "true" if item else "false"
        if type(item) in (int, float):
            return _number(item)
        if type(item) is str:
            return string(item)
        if type(item) not in (list, dict):
            raise ValueError("Unsupported canonical JSON value")
        identity = id(item)
        if identity in active:
            raise ValueError("Cyclic canonical JSON value")
        active.add(identity)
        try:
            if type(item) is list:
                return "[" + ",".join(encode(child) for child in item) + "]"
            parts = []
            for key, child in item.items():
                if type(key) is not str or key in ("__proto__", "constructor", "prototype"):
                    raise ValueError("Invalid canonical JSON key")
                # Typed header/row fields are named, never integer-index keys.
                if key.isascii() and key.isdecimal():
                    raise ValueError("Canonical typed keys must be named")
                parts.append(string(key) + ":" + encode(child))
            return "{" + ",".join(parts) + "}"
        finally:
            active.remove(identity)

    return encode(value).encode("utf-8")
