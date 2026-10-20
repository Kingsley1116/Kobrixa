"""UI v1 semantic validation and a facade over the shared event client."""
import json
import math
import re
from ._schema import Validator, SchemaError


def size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


class UiValidationError(SchemaError):
    def __init__(self, reason):
        super().__init__("Invalid UI value.")
        self.reason = reason
        self.business_code = "PLUGIN_E_UI_VERSION" if reason in {"version", "negotiation"} else "PLUGIN_E_UI_RESOURCE"


def require(condition, reason="schema"):
    if not condition:
        raise UiValidationError(reason)


def key_valid(value):
    return bool(re.fullmatch(r"[a-z][a-z0-9-]{0,31}", value)) and value not in {"__proto__", "prototype", "constructor"}


def text_valid(value, maximum=4000, multiline=True, nonempty=False):
    if not isinstance(value, str) or len(value) > maximum or (nonempty and not value.strip()):
        return False
    return all(not (0xD800 <= ord(c) <= 0xDFFF or ord(c) == 127 or
                   ord(c) < 32 and not (multiline and c in "\t\n")) for c in value)


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def safe_integer(value):
    return number(value) and int(value) == value and abs(value) <= 9007199254740991


def valid_spec(spec):
    if spec["type"] == "number":
        return spec["min"] <= spec["max"] and (not spec["integer"] or
            safe_integer(spec["min"]) and safe_integer(spec["max"]))
    if spec["type"] == "enum":
        return len(set(spec["values"])) == len(spec["values"]) and all(text_valid(v, 128, False, True) for v in spec["values"])
    return True


def accepts(spec, value):
    if value is None:
        return spec["nullable"]
    kind = spec["type"]
    if kind == "string":
        return text_valid(value, spec["maxLength"])
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "enum":
        return isinstance(value, str) and value in spec["values"]
    return number(value) and spec["min"] <= value <= spec["max"] and (not spec["integer"] or safe_integer(value))


def compatible(source, target):
    if source["nullable"] and not target["nullable"]:
        return False
    if source["type"] == "enum" and target["type"] == "string":
        return all(len(value) <= target["maxLength"] for value in source["values"])
    if source["type"] != target["type"]:
        return False
    if source["type"] == "string":
        return source["maxLength"] <= target["maxLength"]
    if source["type"] == "number":
        return source["min"] >= target["min"] and source["max"] <= target["max"] and (not target["integer"] or source["integer"])
    if source["type"] == "enum":
        return set(source["values"]).issubset(target["values"])
    return True


def validate_resource(value, context, raw_bytes, version=1):
    require(version == 1, "version")
    require(safe_integer(raw_bytes) and 0 <= raw_bytes <= 262144, "limit")
    try:
        Validator.bundled().validate("ui-resource-v1", value)
    except SchemaError as error:
        def classify(item):
            if isinstance(item, list):
                for child in item:
                    reason = classify(child)
                    if reason: return reason
            elif isinstance(item, dict):
                if isinstance(item.get("nodes"), list) and len(item["nodes"]) > 256: return "limit"
                for key, child in item.items():
                    if key in {"text", "label", "help", "unit", "placeholder"} and isinstance(child, dict) and not any(k in child for k in ("ref", "text", "en")): return "translation"
                    reason = classify(child)
                    if reason: return reason
            return None
        raise UiValidationError(classify(value) or "schema") from error
    data = value["data"]
    fields = value.get("fields", {})
    require(len(data) <= 64 and len(fields) <= 32)
    for record in (data, fields):
        for key, slot in record.items():
            require(key_valid(key) and valid_spec(slot["schema"]) and accepts(slot["schema"], slot["initial"]))

    def text(item, label=False):
        require(all(len(s) <= (200 if label else 4000) for s in item.values()), "limit")
        require(all(text_valid(s, 200 if label else 4000, not label, True) for s in item.values()), "translation")

    def ref(item):
        record = data if item["scope"] == "data" else fields
        require(item["key"] in record, "reference")
        return record[item["key"]]["schema"]

    total = 0
    def condition(item):
        count = 0
        def walk(current, depth):
            nonlocal count, total
            count += 1
            total += 1
            require(depth <= 4 and count <= 32 and total <= 256)
            op = current["op"]
            if op == "not":
                walk(current["item"], depth + 1)
            elif op in ("all", "any"):
                for child in current["items"]:
                    walk(child, depth + 1)
            elif op in ("eq", "ne"):
                spec, right = ref(current["left"]), current["right"]
                expected = "string" if spec["type"] == "enum" else spec["type"]
                require(spec["nullable"] if right is None else
                        text_valid(right) if expected == "string" else
                        number(right) if expected == "number" else isinstance(right, bool))
            else:
                require(ref(current["left"])["type"] == "number")
        walk(item, 1)

    def display(item):
        if "ref" in item:
            ref(item["ref"])

    def display_text(item):
        if "text" in item:
            text(item["text"])
        else:
            require(ref(item["ref"])["type"] == "string", "reference")

    def command(command_id, arguments):
        target = next((c for c in context["commands"] if c["id"] == command_id), None)
        require(command_id.startswith(context["pluginId"] + ".") and target is not None)
        require(set(arguments) == set(target["arguments"]) and len(arguments) <= 32 and size(arguments) <= 16384)
        for key, item in arguments.items():
            require(key_valid(key))
            require(accepts(target["arguments"][key], item["literal"]) if "literal" in item else
                    compatible(ref(item["ref"]), target["arguments"][key]))

    if value["kind"] == "status":
        display_text(value["text"])
        if "visibleWhen" in value:
            condition(value["visibleWhen"])
    else:
        nodes = {n["id"]: n for n in value["nodes"]}
        require(len(nodes) == len(value["nodes"]) and nodes.get(value["root"], {}).get("type") == "group", "reference")
        visited = set()
        def tree(node_id, depth):
            require(depth <= 8, "limit")
            require(node_id in nodes, "reference")
            require(node_id not in visited, "cycle")
            visited.add(node_id)
            for child in nodes[node_id].get("children", []):
                tree(child, depth + 1)
        tree(value["root"], 1)
        require(len(visited) == len(nodes), "reference")
        used = set()
        for node in nodes.values():
            require(key_valid(node["id"]))
            for key in ("visibleWhen", "enabledWhen"):
                if key in node:
                    condition(node[key])
            for key in ("label", "help", "unit", "placeholder"):
                if key in node:
                    text(node[key], key != "help")
            kind = node["type"]
            if "field" in node:
                key = node["field"]
                require(key in fields and key not in used)
                used.add(key)
                field = fields[key]
                spec = field["schema"]
                expected = {"textInput": "string", "number": "number", "range": "number", "choice": "enum", "boolean": "boolean"}[kind]
                require(spec["type"] == expected)
                if kind == "textInput" and field["initial"] is not None:
                    require(text_valid(field["initial"], 4000, False))
                if kind in ("number", "range"):
                    require(not spec["integer"] or safe_integer(node["step"]))
                    if kind == "range" and field["initial"] is not None:
                        q = (field["initial"] - spec["min"]) / node["step"]
                        require(abs(q - round(q)) <= 1e-9 * max(1, abs(q)))
                if kind == "choice":
                    options = [o["value"] for o in node["options"]]
                    require(len(set(options)) == len(options) and set(options) == set(spec["values"]))
                    require(node["presentation"] != "segmented" or len(options) <= 8)
                    for option in node["options"]:
                        text(option["label"], True)
            if kind in ("text", "help"):
                display_text(node["value"])
            if kind in ("status", "alert"):
                display_text(node["text"])
            if kind == "progress":
                item = node["value"]
                display(item)
                if "ref" in item:
                    require(ref(item["ref"])["type"] == "number")
                    slots = data if item["ref"]["scope"] == "data" else fields
                    initial = slots[item["ref"]["key"]]["initial"]
                    require(initial is None or number(initial) and 0 <= initial <= node["max"])
                else:
                    require(item["literal"] is None or number(item["literal"]) and 0 <= item["literal"] <= node["max"])
            if kind == "keyValue":
                require(len({r["id"] for r in node["rows"]}) == len(node["rows"]))
                for row in node["rows"]:
                    require(key_valid(row["id"]))
                    text(row["label"], True)
                    if "unit" in row:
                        text(row["unit"], True)
                    display(row["value"])
            if kind == "holdAction":
                command(node["command"], node["arguments"])
            if kind == "action":
                action = node["action"]
                if action["kind"] == "command":
                    command(action["command"], action["arguments"])
                elif action["action"] == "openPanel":
                    require(action["panelId"].startswith(context["pluginId"] + ".") and
                            any(p["id"] == action["panelId"] for p in context["panels"]))
                elif action["action"] in ("stop", "disconnect"):
                    spec = ref(action["operation"] if action["action"] == "stop" else action["session"])
                    require(spec["type"] == "string" and spec["nullable"])
        require(used == set(fields))
        for field in fields.values():
            if "requiredWhen" in field:
                condition(field["requiredWhen"])
        require(size({k: f["initial"] for k, f in fields.items()}) <= 16384)
    validate_data(value, {key: slot["initial"] for key, slot in data.items()})
    return value


def validate_data(resource, data):
    require(set(data) == set(resource["data"]))
    require(all(accepts(resource["data"][key]["schema"], value) for key, value in data.items()))
    require(size(data) <= (16384 if resource["kind"] == "status" else 65536))
    for node in resource.get("nodes", []):
        if node["type"] == "progress" and "ref" in node["value"] and node["value"]["ref"]["scope"] == "data":
            value = data[node["value"]["ref"]["key"]]
            require(value is None or number(value) and 0 <= value <= node["max"])
    return data


def validate_invocation(value):
    Validator.bundled().validate("command/invoke.params", value)
    require(size(value) <= 65536 and size(value["arguments"]) <= 16384 and len(value["arguments"]) <= 32)
    require(all(key_valid(key) for key in value["arguments"]))
    context = value["context"]
    if context["origin"] == "management":
        require(not any(key in context for key in ("binding", "form", "motionScopeRef")))
        require(context["trigger"]["kind"] == "activate" and value["arguments"] == {})
    else:
        require("binding" in context and "form" in context)
    if "actionRef" in context and context["trigger"]["kind"] == "hold":
        require(context["trigger"]["phase"] == "begin")
    form = context.get("form", {"values": {}})
    require(len(form["values"]) <= 32 and size(form) <= 16384 and all(key_valid(k) for k in form["values"]))
    require(all(not isinstance(v, str) or text_valid(v) for v in
                list(value["arguments"].values()) + list(form["values"].values())))
    return value


def validate_result(value, invocation):
    Validator.bundled().validate("command/invoke.result", {"ok": True, "value": value})
    require(size(value) <= 16384 and len(value["output"]) <= 32 and all(key_valid(k) for k in value["output"]))
    require(all(not isinstance(v, str) or text_valid(v) for v in value["output"].values()))
    fields = invocation["context"].get("form", {}).get("values", {})
    errors = value["fieldErrors"]
    require(len({e["field"] for e in errors}) == len(errors))
    for error in errors:
        require(error["field"] in fields and all(text_valid(s, nonempty=True) for s in error["message"].values()))
    return value


class Ui:
    def __init__(self, request, events):
        self._request, self._events = request, events
        self._ready = False

    def mark_ready(self):
        self._ready = True

    def retire(self):
        self._ready = False

    def _check(self):
        if not self._ready:
            raise RuntimeError("UI is not ready.")

    async def show_message(self, message, severity="info"):
        await self._request("ui/showMessage", {"message": message, "severity": severity})

    async def instances(self):
        self._check()
        return await self._request("ui/instances", {})

    async def state(self, binding):
        self._check()
        return await self._request("ui/state", {"binding": binding})

    async def patch(self, binding, base_revision, values):
        self._check()
        return await self._request("ui/patch", {"binding": binding, "baseRevision": base_revision, "set": values})

    async def subscribe(self, topics, callback, binding=None):
        self._check()
        require(len(set(topics)) == len(topics) and 1 <= len(topics) <= 5)
        require(binding is not None or set(topics).issubset({"instances", "environment"}))
        params = {"topics": topics}
        if binding is not None:
            params["binding"] = binding
        finish = self._events.begin()
        try:
            result = await self._request("ui/subscribe", params)
            if result["ok"]:
                value = result["value"]
                async def snapshot():
                    return await self.snapshot(value["subscriptionId"])
                self._events.adopt(subscription_id=value["subscriptionId"], sequence=value["sequence"],
                                   snapshot=snapshot, listener=callback)
            return result
        finally:
            finish()

    async def snapshot(self, subscription_id):
        self._check()
        return await self._request("ui/snapshot", {"subscriptionId": subscription_id})

    async def unsubscribe(self, subscription_id):
        result = await self._request("events/unsubscribe", {"subscriptionId": subscription_id})
        if result["ok"]:
            self._events.forget(subscription_id)
        return result

def valid_wire(method, phase, value, params=None):
    methods = {"ui/negotiate", "ui/ready", "ui/instances", "ui/state", "ui/patch", "ui/subscribe", "ui/snapshot", "command/invoke"}
    if method not in methods:
        return True
    try:
        if phase == "params":
            if method == "command/invoke":
                validate_invocation(value)
            elif method == "ui/patch":
                require(size(value) <= 65536 and 1 <= len(value["set"]) <= 64)
                require(all(key_valid(k) for k in value["set"]))
                require(all(not isinstance(v, str) or text_valid(v) for v in value["set"].values()))
            elif method == "ui/subscribe":
                topics = value["topics"]
                require(len(set(topics)) == len(topics))
                require("binding" in value or set(topics).issubset({"instances", "environment"}))
            return True
        if not value["ok"]:
            error = value["error"]
            return text_valid(error["message"], 2000) and ("detail" not in error or size(error["detail"]) <= 4096)
        if method == "command/invoke":
            validate_result(value["value"], validate_invocation(params))
            return True
        states = [value["value"]] if method == "ui/state" else value["value"]["snapshot"]["states"] if method in {"ui/subscribe", "ui/snapshot"} else []
        for state in states:
            data, form = state["data"], state["form"]
            require(len(data) <= 64 and len(form) <= 32 and size(form) <= 16384)
            require(size(data) <= (16384 if state["binding"]["kind"] == "status" else 65536))
            require(all(key_valid(k) for k in list(data) + list(form)))
            require(all(not isinstance(v, str) or text_valid(v) for v in list(data.values()) + list(form.values())))
        return True
    except (SchemaError, KeyError, TypeError, ValueError, UnicodeError):
        return False
