"""Context commands are immutable per invocation; no global last-context state."""
import asyncio
import copy
import inspect
import json
import time
from collections import OrderedDict
from dataclasses import dataclass
from types import MappingProxyType
from ._schema import SchemaError
from ._ui import accepts, key_valid, valid_spec, validate_invocation, validate_result, require


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(freeze(item) for item in value)
    return value


@dataclass(frozen=True)
class ContextCommandContext:
    version: int
    invocation_id: str
    command: str
    arguments: object
    context: object


def failure(code):
    return {"ok": False, "error": {"code": code, "message":
            "Command failed." if code == "PLUGIN_E_COMMAND_FAILED" else "Command did not complete."}}


class ContextCommands:
    def __init__(self, plugin_id, clock=time.monotonic):
        self._plugin_id, self._clock = plugin_id, clock
        self._handlers = {}
        self._pending = {}
        self._completed = OrderedDict()

    def register(self, command_id, arguments, handler):
        require(command_id not in self._handlers and len(arguments) <= 32)
        require(all(key_valid(k) and valid_spec(v) for k, v in arguments.items()))
        if not inspect.iscoroutinefunction(handler):
            raise TypeError("Context command handlers must be async functions.")
        self._handlers[command_id] = (copy.deepcopy(arguments), handler)

    async def invoke(self, value):
        value = copy.deepcopy(validate_invocation(value))
        require(value["command"].startswith(self._plugin_id() + ".") and value["command"] in self._handlers)
        binding = value["context"].get("binding")
        require(binding is None or binding["contributionId"].startswith(self._plugin_id() + "."))
        arguments, handler = self._handlers[value["command"]]
        require(set(arguments) == set(value["arguments"]) and
                all(accepts(spec, value["arguments"][key]) for key, spec in arguments.items()))
        key = json.dumps(value, sort_keys=True, separators=(",", ":"))
        invocation_id = value["invocationId"]
        for done_id, done in list(self._completed.items()):
            if self._clock() - done[2] >= 30:
                del self._completed[done_id]
        if invocation_id in self._completed:
            previous_key, result, _ = self._completed[invocation_id]
            require(previous_key == key)
            return copy.deepcopy(result)
        if invocation_id in self._pending:
            previous_key, task = self._pending[invocation_id]
            require(previous_key == key)
            return copy.deepcopy(await asyncio.shield(task))
        if len(self._pending) >= 16:
            return {"ok": False, "error": {"code": "PLUGIN_E_RESOURCE_LIMIT", "message": "Command queue is full.",
                    "detail": {"kind": "resource", "reason": "queue", "resource": "rpc", "limit": 16}}}
        async def execute():
            context = ContextCommandContext(value["version"], invocation_id, value["command"],
                                            freeze(value["arguments"]), freeze(value["context"]))
            child = asyncio.create_task(handler(context))
            def consume(done):
                if not done.cancelled():
                    done.exception()
            child.add_done_callback(consume)
            try:
                done, _ = await asyncio.wait({child}, timeout=30)
                if not done:
                    child.cancel()
                    result = failure("PLUGIN_E_TIMEOUT")
                else:
                    result = {"ok": True, "value": validate_result(child.result(), value)}
            except asyncio.CancelledError:
                child.cancel()
                result = failure("PLUGIN_E_CANCELLED")
            except Exception:
                result = failure("PLUGIN_E_COMMAND_FAILED")
            self._completed[invocation_id] = (key, copy.deepcopy(result), self._clock())
            while len(self._completed) > 64:
                self._completed.popitem(last=False)
            self._pending.pop(invocation_id, None)
            return result
        task = asyncio.create_task(execute())
        self._pending[invocation_id] = (key, task)
        try:
            return copy.deepcopy(await asyncio.shield(task))
        except asyncio.CancelledError:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if invocation_id not in self._completed:
                self._completed[invocation_id] = (key, failure("PLUGIN_E_CANCELLED"), self._clock())
                self._pending.pop(invocation_id, None)
            raise
