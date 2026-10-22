"""Validates messages against the committed Kobrixa JSON Schema.

Implements exactly the keywords in packages/plugin-protocol/schema/keywords.json.
String lengths count Unicode code points, as JSON Schema and Zod 4 do, and an
anchored trailing "$" means end of string, as in ECMAScript.
"""
import json
import math
import ipaddress
import re
from functools import lru_cache
from importlib import resources

SUPPORTED_KEYWORDS = frozenset({
    "$schema", "$id", "title", "$defs", "type", "properties", "required",
    "additionalProperties", "enum", "const", "pattern", "minLength", "maxLength",
    "minimum", "maximum", "items", "minItems", "maxItems", "anyOf", "oneOf",
})


class SchemaError(ValueError):
    pass


@lru_cache(maxsize=None)
def _regex(pattern: str) -> "re.Pattern[str]":
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.compile(pattern)


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and (isinstance(value, int) or math.isfinite(value))


def _is_type(value, name: str) -> bool:
    if name == "integer":
        return _is_number(value) and (isinstance(value, int) or value.is_integer())
    return {
        "number": _is_number(value),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
        "null": value is None,
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
    }[name]


def _equal(left, right) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    return left == right


class Validator:
    def __init__(self, document: dict) -> None:
        self._definitions = document["$defs"]

    @classmethod
    def bundled(cls) -> "Validator":
        text = resources.files("kobrixa").joinpath("plugin-protocol.schema.json").read_text("utf-8")
        return cls(json.loads(text))

    def has(self, name: str) -> bool:
        return name in self._definitions

    def validate(self, name: str, value) -> None:
        errors = self._check(self._definitions[name], value, "$")
        if errors:
            raise SchemaError(errors[0])
        _device_semantics(name, value)

    def _check(self, schema: dict, value, path: str) -> list:
        unknown = set(schema) - SUPPORTED_KEYWORDS
        if unknown:
            raise SchemaError(f"Unsupported schema keywords: {sorted(unknown)}")
        if "anyOf" in schema and not any(not self._check(item, value, path) for item in schema["anyOf"]):
            return [f"{path}: no alternative matched"]
        if "oneOf" in schema and sum(1 for item in schema["oneOf"] if not self._check(item, value, path)) != 1:
            return [f"{path}: expected exactly one alternative"]
        if "const" in schema and not _equal(value, schema["const"]):
            return [f"{path}: expected {schema['const']!r}"]
        if "enum" in schema and not any(_equal(value, item) for item in schema["enum"]):
            return [f"{path}: expected one of {schema['enum']!r}"]
        if "type" in schema:
            types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(_is_type(value, item) for item in types):
                return [f"{path}: expected {schema['type']}"]
        errors = []
        if isinstance(value, str):
            length = len(value)  # Python str length is the code point count.
            if length < schema.get("minLength", 0) or length > schema.get("maxLength", length):
                errors.append(f"{path}: length {length} is out of range")
            if "pattern" in schema and not _regex(schema["pattern"]).search(value):
                errors.append(f"{path}: does not match {schema['pattern']}")
        if _is_number(value):
            if value < schema.get("minimum", value) or value > schema.get("maximum", value):
                errors.append(f"{path}: {value} is out of range")
        if isinstance(value, list):
            if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
                errors.append(f"{path}: wrong number of items")
            if "items" in schema:
                for index, item in enumerate(value):
                    errors += self._check(schema["items"], item, f"{path}[{index}]")
        if isinstance(value, dict):
            properties = schema.get("properties", {})
            for key in schema.get("required", []):
                if key not in value:
                    errors.append(f"{path}.{key}: is required")
            for key, item in value.items():
                if key in properties:
                    errors += self._check(properties[key], item, f"{path}.{key}")
                elif schema.get("additionalProperties") is False:
                    errors.append(f"{path}.{key}: is not allowed")
                elif isinstance(schema.get("additionalProperties"), dict):
                    errors += self._check(schema["additionalProperties"], item, f"{path}.{key}")
        return errors

_DEVICE_REASONS={
 'PLUGIN_E_DEVICE_UNAVAILABLE':('provider-disabled','disconnected','quarantined','ui-scope-unavailable'),
 'PLUGIN_E_DEVICE_CAPABILITY':('unsupported-capability',),
 'PLUGIN_E_DEVICE_BUSY':('foreground','recording','connecting','source-changing'),
 'PLUGIN_E_DEVICE_AUTHORITY':('unbound','joining','unsynced','not-holder','viewer','authority-changed','scope-expired'),
 'PLUGIN_E_DEVICE_OPERATION':('preflight-program-running','preflight-output-unknown','preflight-output-moving','motor-unavailable','source-changed','mode-unavailable','provider-failure','provider-contract','journal-unwritable','journal-corrupt','identity-ambiguous'),
 'PLUGIN_E_DEVICE_STOP_UNCONFIRMED':('readback-failed','stop-deadline','connection-lost','provider-stalled'),
 'PLUGIN_E_TIMEOUT':('deadline',),'PLUGIN_E_CANCELLED':('cancelled',),'PLUGIN_E_DISABLED':('disabled',),
 'PLUGIN_E_SAFE_MODE':('safe-mode',),'PLUGIN_E_SHUTTING_DOWN':('shutting-down',),'PLUGIN_E_CRASHED':('process-lost',),
 'PLUGIN_E_PROTOCOL':('protocol',),'PLUGIN_E_PROVIDER_CONFLICT':('provider-conflict',),
}
def _device_semantics(name,value):
    if not name.startswith(('devices/','events/')): return
    def fail(): raise SchemaError('Invalid device wire value')
    try: size=len(json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('utf-8'))
    except (ValueError,UnicodeError): fail()
    if size>1048576: fail()
    if name.endswith('.params') and name!='events/deliver.params' and size>16384: fail()
    if name=='devices/recording/read.result' and size>65536: fail()
    if name.endswith('.result') and (name.startswith('devices/motion/') or name=='devices/recording/query.result') and size>16384: fail()
    def walk(node,key='',parent=None):
        if isinstance(node,str):
            if '\0' in node or any(0xD800<=ord(c)<=0xDFFF for c in node): fail()
            maximum=None
            if key=='name': maximum=80 if parent and any(k in parent for k in ('channelId','actuatorId','modeId')) else 200
            if key=='modeName': maximum=80
            if key=='unit': maximum=32
            if key=='message': maximum=2000
            if maximum is not None and len(node)>maximum: fail()
            if key=='address':
                try:
                    if '%' in node or str(ipaddress.ip_address(node))!=node: fail()
                except ValueError: fail()
        elif isinstance(node,list):
            if key in ('channelIds','capabilities','affected') and len(set(json.dumps(v,sort_keys=True) for v in node))!=len(node): fail()
            unique={'channels':'channelId','actuators':'actuatorId','values':'channelId','candidates':'candidateId','providers':'providerId','sessions':'sessionId','modes':'modeId'}.get(key)
            if unique and len({v[unique] for v in node})!=len(node): fail()
            for child in node: walk(child,key)
        elif isinstance(node,dict):
            if 'fromSequence' in node and node['fromSequence']>node['toSequence']: fail()
            if 'motionScopeRef' in node and (node['motion']['mode']=='jog')!=('gestureRef' in node): fail()
            if 'code' in node and 'detail' in node:
                detail=node['detail'];code=node['code'];kind=detail['kind']
                if kind=='permission' and code!='PLUGIN_E_PERMISSION_DENIED': fail()
                elif kind=='resource' and code!=('PLUGIN_E_STALE_RESOURCE' if detail['reason']=='stale' else 'PLUGIN_E_RESOURCE_LIMIT'): fail()
                elif kind=='device' and detail['reason'] not in _DEVICE_REASONS.get(code,()): fail()
                elif kind not in ('permission','resource','device'): fail()
            if node.get('version')==1 and 'delivery' in node:
                if size>(16384 if node['delivery']=='control' else 65536): fail()
            for k,v in node.items(): walk(v,k,node)
    walk(value)
