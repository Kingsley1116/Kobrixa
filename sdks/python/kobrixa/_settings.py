from typing import Any, Awaitable, Callable
PersistenceRequest = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
"""Isolated 1.7 helpers. _plugin.py attaches them only in the P170 batch."""
import asyncio
import json
import math
import re

MAX_SAFE = 9007199254740991
HANDLE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
REVISION = re.compile(r"r_[0-9a-f]{32}\Z")

def wire_bytes(value):
    # Match the protocol's UTF-8 JSON byte budget, not Python ensure_ascii=True's wire spelling.
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))

def integer(value, low=0, high=MAX_SAFE):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not low <= value <= high:
        raise ValueError("invalid-integer")
    return value

def text(value, low, high, byte_limit, single=False):
    if not isinstance(value, str) or "\0" in value or any(0xd800 <= ord(c) <= 0xdfff for c in value):
        raise ValueError("invalid-text")
    if not low <= len(value) <= high or len(value.encode("utf-8")) > byte_limit or (single and any(ord(c) < 32 or ord(c) == 127 or c in "\u2028\u2029" for c in value)):
        raise ValueError("size-limit")
    return value

def obj(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise ValueError("invalid-object")
    return value

def key(value):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*", value) or any(k in ("constructor", "prototype", "__proto__") for k in value.split(".")):
        raise ValueError("invalid-key")
    return value

def localized(value, help_text=False):
    obj(value, ["en"], ["zh-TW"])
    for v in value.values(): text(v, 0 if help_text else 1, 2000 if help_text else 200, 8192 if help_text else 800, not help_text)

def number(value, safe=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value): raise ValueError("invalid-number")
    if safe: integer(value, -MAX_SAFE, MAX_SAFE)

def enum_token(value):
    if isinstance(value, str): text(value, 0, 4000, 4096); return ("string", value)
    number(value, True)
    return ("number", value)

def validate_values(resource, values, complete):
    if wire_bytes(values) > 65536: raise ValueError("size-limit")
    if not isinstance(values, list) or len(values) > 128: raise ValueError("invalid-value")
    fields = {f["key"]: f for f in resource["fields"]}
    seen = set()
    for entry in values:
        obj(entry, ["key", "value"])
        k, v = key(entry["key"]), entry["value"]
        if k in seen: raise ValueError("duplicate-key")
        seen.add(k)
        if k not in fields: raise ValueError("unknown-key")
        f = fields[k]
        if f["type"] == "boolean":
            if not isinstance(v, bool): raise ValueError("invalid-value")
        elif f["type"] in ("number", "integer"):
            number(v, f["type"] == "integer")
            if not f["minimum"] <= v <= f["maximum"]: raise ValueError("invalid-value")
        elif f["type"] == "string": text(v, f["minLength"], f["maxLength"], f["maxBytes"])
        elif enum_token(v) not in [enum_token(o["value"]) for o in f["options"]]: raise ValueError("invalid-value")
    if complete and seen != set(fields): raise ValueError("invalid-value")
    return values

def validate_resource(resource, raw_bytes):
    integer(raw_bytes, 0, 65536)
    obj(resource, ["schemaVersion", "title", "fields"])
    integer(resource["schemaVersion"], 1, 2147483647)
    localized(resource["title"])
    if not isinstance(resource["fields"], list) or not 1 <= len(resource["fields"]) <= 128: raise ValueError("invalid-resource")
    seen = set()
    for f in resource["fields"]:
        if not isinstance(f, dict): raise ValueError("invalid-field")
        kind = f.get("type")
        extras = {"boolean": [], "number": ["minimum", "maximum"], "integer": ["minimum", "maximum"], "string": ["minLength", "maxLength", "maxBytes"], "enum": ["options"]}
        if kind not in extras: raise ValueError("invalid-type")
        obj(f, ["key", "label", "type", "default"] + extras[kind], ["help"])
        k = key(f["key"])
        if k in seen: raise ValueError("duplicate-key")
        seen.add(k)
        localized(f["label"])
        if "help" in f: localized(f["help"], True)
        if kind in ("number", "integer"):
            number(f["minimum"], kind == "integer"); number(f["maximum"], kind == "integer")
            if f["minimum"] > f["maximum"]: raise ValueError("invalid-range")
        if kind == "string":
            integer(f["minLength"], 0, 4000); integer(f["maxLength"], 0, 4000); integer(f["maxBytes"], 1, 4096)
            if f["minLength"] > f["maxLength"]: raise ValueError("invalid-range")
        if kind == "enum":
            if not isinstance(f["options"], list) or not 1 <= len(f["options"]) <= 32: raise ValueError("invalid-options")
            tokens = []
            for option in f["options"]:
                obj(option, ["value", "label"]); localized(option["label"]); tokens.append(enum_token(option["value"]))
            if len(set(tokens)) != len(tokens): raise ValueError("duplicate-key")
    validate_values(resource, [{"key": f["key"], "value": f["default"]} for f in resource["fields"]], True)
    return resource

def check_version(stored, declared, old_digest, new_digest):
    integer(stored, 1, 2147483647); integer(declared, 1, 2147483647)
    if stored > declared: raise ValueError("downgrade")
    if stored < declared: raise ValueError("migration-required")
    if old_digest != new_digest: raise ValueError("schema-changed-without-version")

class PersistenceClient:
    def __init__(self, request, validate=None):
        from ._schema import Validator
        validator = Validator.bundled()
        self._request = request
        self._validate = validate or (lambda method, phase, value: validator.validate(f"{method}.{phase}", value))

    async def _call(self, method, params):
        # P170 injects generated structural + shared semantic validation here.
        self._validate(method, "params", params)
        result = await asyncio.wait_for(self._request(method, params), timeout=10.0)
        self._validate(method, "result", result)
        return result

class Settings(PersistenceClient):
    async def read(self, params): return await self._call("settings/read", params)
    async def update(self, params): return await self._call("settings/update", params)
    async def reset(self, params): return await self._call("settings/reset", params)
    async def watch(self, params): return await self._call("settings/watch", params)
    async def read_migration(self, params): return await self._call("settings/readMigration", params)
    async def migrate(self, params): return await self._call("settings/migrate", params)

def create_settings_client(request: PersistenceRequest) -> Settings:
    return Settings(request)
