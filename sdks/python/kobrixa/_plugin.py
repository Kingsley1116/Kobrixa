from ._connection_recovery import supported as recovery_supported, request as recovery_request, validate_result as validate_recovery_result
import copy
from ._ui_data import validate_read, validate_snapshot
from ._ui_v2_data import validate_header, validate_chunk
from ._settings import create_settings_client
from ._storage import create_storage_client
from ._persistence_actions import create_persistence_actions_client
from ._events import settings_event_client


class PersistenceDrainContext:
    def __init__(self, request, storage):
        self.request = request
        self.storage = storage


def _supports_persistence(version):
    parts = version.split(".")
    return len(parts) == 3 and all(part.isascii() and part.isdigit() for part in parts) and int(parts[0]) == 1 and int(parts[1]) >= 7


class _InvocationActions:
    def __init__(self, client, invocation):
        self._client = client
        self._action_ref = invocation.get("context", {}).get("actionRef")

    @property
    def actionRef(self):
        if self._action_ref is None:
            raise AttributeError("actionRef")
        return self._action_ref

    def __getattr__(self, name):
        return getattr(self._client, name)


from ._ui import Ui, validate_invocation
from ._commands import ContextCommands, ContextCommandContext
from ._events import ui_event_client_port

from ._ui import valid_wire
"""Python plugin runtime: JSON-RPC 2.0 over stdio with Content-Length framing."""
import asyncio
import inspect
import json
import os
import sys
import threading
import time

from ._devices import Devices
from ._events import bind_event_channel, close_event_channel
from ._framing import Decoder, FramingError, encode
from ._schema import SchemaError, Validator

API_VERSION = "1.8.0"
SDK_VERSION = "0.1.0"
_CANCELLED, _INVALID_REQUEST, _INVALID_PARAMS, _METHOD_NOT_FOUND, _INTERNAL = (
    -32800, -32600, -32602, -32601, -32603
)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class _Ui:
    def __init__(self, plugin: "Plugin") -> None:
        self._plugin = plugin

    async def show_message(self, message: str, severity: str = "info") -> None:
        await self._plugin._request("ui/showMessage", {"severity": severity, "message": message})


class CommandContext:
    def __init__(self, plugin: "Plugin") -> None:
        self.plugin_id = plugin.plugin_id
        self.locale = plugin.locale
        self.ui = plugin.ui
        self.devices = plugin.devices
        self.settings = settings_event_client(plugin, create_settings_client(plugin._request))
        self.storage = create_storage_client(plugin._request)
        self.actions = create_persistence_actions_client(plugin._request)
        self.ui.copy_text = self.actions.copy_text


class Plugin:
    def __init__(self) -> None:
        self.plugin_id = ""
        self.locale = "en"
        self.devices = Devices(self._request)
        launch_owner = os.environ.get("KOBRIXA_RESOURCE_OWNER")
        if launch_owner is not None:
            bind_event_channel(self, json.loads(launch_owner, parse_constant=_reject_json_constant))
        self._context_commands = ContextCommands(lambda: self.plugin_id)
        self.ui = Ui(self._request, ui_event_client_port(self))
        self._host_api_version = "0.0.0"
        self._recovery_candidate = False
        self._recovery_ready = False
        self._device_epoch = 0
        self._device_topics = {}
        self._device_inputs = {}
        self._drain_handler = None
        self._ready_callback = None
        self._deactivate_callback = None
        self._ui_negotiated = False
        self._ui_epoch = 0
        self._ui_version = None
        self._ui_data_ready = False
        self._pending_methods = {}
        self._incoming_methods = {}
        self._ui_ready_task = None

        self._commands = {}
        self._tasks = {}
        self._pending = {}
        self._next_id = 1
        self._validator = Validator.bundled()
        self._stopping = False
        self._output = sys.stdout.buffer
        # Reserve real stdout for protocol frames before any top-level print() after Plugin().
        sys.stdout = sys.stderr

    def drain(self, handler):
        if not inspect.iscoroutinefunction(handler):
            raise TypeError("Kobrixa drain handlers must be async functions.")
        if self._drain_handler is not None:
            raise ValueError("A drain handler is already registered.")
        self._drain_handler = handler
        return handler

    def command(self, command_id: str):
        def register(handler):
            if not inspect.iscoroutinefunction(handler):
                raise TypeError("Kobrixa command handlers must be async functions.")
            self._commands[command_id] = handler
            return handler
        return register

    def run(self) -> None:
        # Read the raw descriptor: a daemon thread blocked inside the buffered sys.stdin reader
        # holds its lock and makes interpreter shutdown abort (SIGABRT) after "exit".
        asyncio.run(self._main(sys.stdin.fileno(), self._output))

    async def _main(self, source, output) -> None:
        self._loop = asyncio.get_running_loop()
        self._output = output
        queue: asyncio.Queue = asyncio.Queue()

        def read() -> None:
            decoder = Decoder()
            try:
                while True:
                    chunk = os.read(source, 65536)
                    if not chunk:
                        break
                    for text in decoder.push(chunk):
                        self._loop.call_soon_threadsafe(queue.put_nowait, text)
            except (FramingError, OSError) as error:
                print(f"kobrixa: stopped reading input: {error}", file=sys.stderr)
            finally:
                self._loop.call_soon_threadsafe(queue.put_nowait, None)

        threading.Thread(target=read, daemon=True).start()
        while not self._stopping:
            text = await queue.get()
            if text is None:
                break  # The host closed stdin: exit so no orphan process remains.
            self._receive(text)
        self._retire_devices(False)
        self._retire_ui()
        self._stopping = True  # Nothing is sent after exit or EOF, including cancellation replies.
        close_event_channel(self)
        for task in list(self._tasks.values()):
            task.cancel()

    def _retire_devices(self,reachable=True):
        self.devices.retire(reachable)
        self._device_epoch += 1
        self._recovery_candidate = False
        self._recovery_ready = False
        self._device_topics.clear()

    def _observe_device_result(self, method, result, params):
        if method == "devices/negotiate": self._recovery_ready = self._recovery_candidate and result.get("ok", False)
        if method == "devices/subscribe" and result.get("ok"):
            self._device_topics[result["value"]["subscriptionId"]] = params["topic"]
        if method == "events/unsubscribe" and result.get("ok"):
            self._device_topics.pop(params["subscriptionId"], None)

    def _ui_v2_candidate(self):
        parts = self._host_api_version.split(".")
        return len(parts) == 3 and all(p.isascii() and p.isdigit() for p in parts) and int(parts[0]) == 1 and int(parts[1]) >= 8

    def _validate_ui(self, method, phase, value, params=None):
        name = f"{method}.{phase}"
        if self._validator.has(f"{method}.v1.{phase}") and not (self._ui_v2_candidate() if method == "ui/negotiate" else self._ui_version == 2):
            name = f"{method}.v1.{phase}"
        if not self._recovery_candidate and self._validator.has(f"{method}.v170.{phase}"):
            name = f"{method}.v170.{phase}"
        self._validator.validate(name, value)
        if phase == "result" and self._recovery_candidate:
            validate_recovery_result(method, value, params)
        if method == "events/deliver" and phase == "params":
            topic = self._device_topics.get(value["subscriptionId"])
            if value["kind"] == "devices.connectionRecovery" and (not self._recovery_ready or topic != "connectionRecovery" or value["data"]["hostEpoch"] != value["owner"]["hostEpoch"]):
                raise SchemaError("Recovery event is not correlated to a current subscription")
            if topic == "connectionRecovery" and value["kind"] not in ("devices.connectionRecovery", "events.resyncRequired"):
                raise SchemaError("Wrong recovery event topic")
        if not valid_wire(method, phase, value, params):
            raise SchemaError("Invalid UI semantics")
        if phase == "params":
            if method == "ui/dataBegin": validate_header(value["header"])
            if method == "ui/dataChunk": validate_chunk(value["chunk"])
            if method == "ui/subscribe" and "data" in value["topics"] and value.get("binding", {}).get("kind") != "panel":
                raise SchemaError("Data topic needs panel binding")
        elif isinstance(value, dict) and value.get("ok"):
            if method == "ui/negotiate":
                if any(v not in params[key] for key in ("uiResourceVersions", "commandEnvelopeVersions") for v in value["value"][key]):
                    raise SchemaError("Unoffered UI version")
            if method == "ui/dataRead": validate_read(value["value"], params)
            if method == "ui/dataSnapshot": validate_snapshot(value["value"])
            if method in ("ui/subscribe", "ui/snapshot"):
                groups = value["value"]["snapshot"].get("data", [])
                keys = [json.dumps(g["binding"], sort_keys=True) for g in groups]
                if len(set(keys)) != len(keys): raise SchemaError("Duplicate data binding")
                for group in groups: validate_snapshot({"datasets": group["datasets"]})
                if method == "ui/subscribe" and "data" in params["topics"] and "data" not in value["value"]["snapshot"]:
                    raise SchemaError("Missing data snapshot")
                if method == "ui/subscribe" and any(group["binding"] != params.get("binding") for group in groups):
                    raise SchemaError("Data snapshot binding mismatch")

    def _send(self, message: dict) -> None:
        if self._stopping:
            return
        try:
            method = message.get("method") or self._incoming_methods.get(message.get("id"), "")
            data_frame = (method.startswith("ui/data") or method == "ui/formPatch") or message.get("params", {}).get("kind") == "ui.data"
            text = json.dumps(message, ensure_ascii=not data_frame, separators=(",", ":"))
            if data_frame and len(text.encode("utf-8")) > 65536:
                raise RpcError(_INTERNAL, "UI data frame exceeds 64 KiB.")
            remaining = memoryview(encode(text))
            # Only blocking stdout is supported. A raw nonblocking stream can retry forever
            # if the host stops reading, blocking the event loop until the host force-kills us.
            # A nonblocking BufferedWriter's BlockingIOError is treated as a closed pipe below.
            while remaining:
                written = self._output.write(remaining)
                if written is None or written == 0:
                    # Avoid busy-waiting when a raw stream temporarily makes no progress.
                    time.sleep(0.001)
                    continue
                remaining = remaining[written:]
            self._output.flush()
        except OSError:
            self._retire_devices(False)
            self._retire_ui()
            close_event_channel(self)
            self._stopping = True  # The host closed the pipe; the read loop ends on EOF.

    def _finished(self, request_id, method: str, task: "asyncio.Future") -> None:
        if self._tasks.get(request_id) is task:
            self._tasks.pop(request_id)
        # A request cancelled before its task started never entered _handle(), so it has not
        # replied yet. A started task catches CancelledError itself and finishes normally, so
        # every request gets exactly one reply.
        if task.cancelled():
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _CANCELLED, "message": f"{method} was cancelled."}})

    def _receive(self, text: str) -> None:
        try:
            frame_bytes = len(text.encode("utf-8"))
            message = json.loads(text, parse_constant=_reject_json_constant)
            self._validator.validate("message", message)
            method = message.get("method") or self._pending_methods.get(message.get("id"), "")
            data_event = message.get("method") == "events/deliver" and message.get("params", {}).get("kind") == "ui.data"
            if ((method.startswith("ui/data") or method == "ui/formPatch") or data_event) and frame_bytes > 65536:
                error = RpcError(_INTERNAL, "UI data frame exceeds 64 KiB.")
                if "method" not in message:
                    pending = self._pending.pop(message.get("id"), None)
                    if pending and not pending.done(): pending.set_exception(error)
                elif "id" in message:
                    self._send({"jsonrpc":"2.0", "id":message["id"], "error":{"code":_INVALID_PARAMS, "message":str(error)}})
                return
            if data_event and (self._ui_version != 2 or not self._ui_data_ready):
                raise SchemaError("UI data event before v2 ready")
            if "method" in message and "id" in message:
                request_id, method = message["id"], message["method"]
                if request_id in self._tasks:
                    self._send({"jsonrpc": "2.0", "id": request_id,
                                "error": {"code": _INVALID_REQUEST,
                                          "message": "Duplicate request id."}})
                    return
                if method in ("initialize", "shutdown"): self._retire_devices()
                task = asyncio.ensure_future(self._handle(message))
                self._tasks[request_id] = task
                task.add_done_callback(lambda done: self._finished(request_id, method, done))
            elif "method" in message:
                method, params = message["method"], message.get("params")
                if not self._validator.has(f"{method}.params"):
                    raise SchemaError(f"Unknown notification {method}.")
                self._validate_ui(method, "params", params)
                if method == "$/cancelRequest":
                    task = self._tasks.get(params["id"])
                    if task:
                        task.cancel()
                elif method == "events/deliver":
                    if params["kind"] == "events.resyncRequired" and params["subscriptionId"] in self._device_topics:
                        for id in [params["subscriptionId"], *params["data"]["affected"]]:
                            if self._device_topics.get(id) == "connectionRecovery": self._device_topics.pop(id, None)
                    self.devices.inbox.accept(params) if self.devices.inbox is not None else None
                elif method == "exit":
                    self._retire_devices(False)
                    self._retire_ui()
                    close_event_channel(self)
                    self._stopping = True
            else:
                future = self._pending.pop(message["id"], None)
                if future and not future.done():
                    original = self._device_inputs.get(message["id"])
                    if original and "result" in message:
                        original_method, original_params, original_epoch = original
                        try:
                            if original_epoch != self._device_epoch: raise SchemaError("Device session retired")
                            self._validate_ui(original_method, "result", message["result"], original_params)
                            self._observe_device_result(original_method, message["result"], original_params)
                        except (ValueError, SchemaError) as error:
                            future.set_exception(error)
                            return
                    future.set_result(message)
        except (ValueError, SchemaError) as error:
            print(f"kobrixa: ignored invalid message from host: {error}", file=sys.stderr)
        except Exception as error:  # noqa: BLE001 - one bad message must not stop the transport
            print(f"kobrixa: failed to process message from host: {error}", file=sys.stderr)

    def context_command(self, command_id, arguments=None):
        schema = {} if arguments is None else arguments
        def register(handler):
            if command_id in self._commands:
                raise ValueError("Command already registered.")
            async def invoke(context):
                from collections.abc import Mapping
                def copy_wire(value):
                    if isinstance(value, Mapping): return {key: copy_wire(item) for key, item in value.items()}
                    if isinstance(value, tuple): return [copy_wire(item) for item in value]
                    return value
                local = create_invocation_context(CommandContext(self), {"version": context.version, "invocationId": context.invocation_id, "command": context.command, "arguments": copy_wire(context.arguments), "context": copy_wire(context.context)})
                local._command_context = context
                return await handler(local)
            self._context_commands.register(command_id, schema, invoke)
            return handler
        return register

    def ready(self, handler):
        if self._ready_callback is not None or not inspect.iscoroutinefunction(handler):
            raise TypeError("Register exactly one async ready callback.")
        self._ready_callback = handler
        return handler

    def deactivate(self, handler):
        if self._deactivate_callback is not None or not inspect.iscoroutinefunction(handler):
            raise TypeError("Register exactly one async deactivate callback.")
        self._deactivate_callback = handler
        return handler

    def _retire_ui(self):
        self._ui_epoch += 1
        self.ui.retire()
        self._ui_data_ready = False
        self._ui_negotiated = False
        self._ui_version = None
        self._ui_ready_task = None

    async def _ui_ready(self):
        epoch = self._ui_epoch
        self.ui.mark_ready(self._ui_version)
        self._ui_data_ready = self._ui_version == 2
        try:
            if self._ready_callback is not None:
                await self._ready_callback(CommandContext(self))
            if epoch != self._ui_epoch: raise asyncio.CancelledError()
            return {"ok": True, "value": {}}
        except asyncio.CancelledError:
            if epoch == self._ui_epoch: self._retire_ui()
            raise
        except Exception:
            if epoch == self._ui_epoch: self._retire_ui()
            return {"ok": False, "error": {"code": "PLUGIN_E_UI_VERSION", "message": "UI initialization failed.",
                    "detail": {"kind": "ui", "reason": "negotiation"}}}

    async def _handle(self, message: dict) -> None:
        request_id, method = message["id"], message["method"]
        self._incoming_methods[request_id] = method
        if method in ("initialize", "shutdown"): self._retire_devices()
        epoch = self._ui_epoch
        device_epoch = self._device_epoch
        try:
            if not self._validator.has(f"{method}.params") or method == "ui/showMessage":
                raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")
            params = message.get("params")
            try:
                self._validate_ui(method, "params", params)
            except SchemaError as error:
                raise RpcError(_INVALID_PARAMS, f"Invalid parameters for {method}: {error}") from error
            if not valid_wire(method, "params", params):
                raise RpcError(_INVALID_PARAMS, "Invalid UI parameters.")
            result = await self._dispatch(method, params)
            self._validate_ui(method, "result", result, params)
            if not valid_wire(method, "result", result, params):
                raise RpcError(_INTERNAL, "Invalid UI result.")
            if method == "initialize" and device_epoch != self._device_epoch: raise asyncio.CancelledError()
            self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
            if method == "initialize" and not self._stopping:
                self._recovery_candidate = recovery_supported(params["apiVersion"]) and recovery_supported(result["apiVersion"])
                self.devices.initialized(params["apiVersion"])
        except asyncio.CancelledError:
            if method == "ui/ready" and epoch == self._ui_epoch: self._retire_ui()
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _CANCELLED, "message": f"{method} was cancelled."}})
        except RpcError as error:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": error.code, "message": str(error)[:2000]}})
        except Exception as error:  # noqa: BLE001 - report handler failures to the host
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _INTERNAL, "message": str(error)[:2000] or type(error).__name__}})

        finally:
            self._incoming_methods.pop(request_id, None)

    async def _dispatch(self, method: str, params: dict):
        if method == "initialize":
            self.plugin_id, self.locale = params["pluginId"], params["locale"]
            self._host_api_version = params["apiVersion"]
            self._retire_ui()
            return {"apiVersion": API_VERSION, "sdk": {"name": "kobrixa-plugin-sdk", "version": SDK_VERSION}}
        if method == "storage/drain":
            if not _supports_persistence(self._host_api_version) or self._drain_handler is None:
                raise RpcError(_METHOD_NOT_FOUND, "Persistence drain was not negotiated or registered.")
            return await self._drain_handler(PersistenceDrainContext(params, create_storage_client(self._request)))
        if method == "command/execute":
            handler = self._commands.get(params["command"])
            if handler is None:
                raise RpcError(_INVALID_PARAMS, f"The plugin did not register {params['command']}.")
            await handler(CommandContext(self))
            return None
        if method == "shutdown":
            self._retire_devices()
            self._retire_ui()
            if self._deactivate_callback is not None:
                await self._deactivate_callback()
            return None
        if method == "ui/negotiate":
            self._retire_ui()
            versions = [v for v in ([1, 2] if self._ui_v2_candidate() else [1]) if v in params["uiResourceVersions"]]
            self._ui_version = max(versions, default=None)
            self._ui_negotiated = bool(self.plugin_id) and 1 in params["commandEnvelopeVersions"] and self._ui_version is not None
            return {"ok": True, "value": {"commandEnvelopeVersions": [1] if self._ui_negotiated else [],
                    "uiResourceVersions": versions}}
        if method == "ui/ready":
            if not self._ui_negotiated:
                return {"ok": False, "error": {"code": "PLUGIN_E_UI_VERSION", "message": "UI negotiation is required.",
                        "detail": {"kind": "ui", "reason": "negotiation"}}}
            if self._ui_ready_task is None:
                self._ui_ready_task = asyncio.create_task(self._ui_ready())
            return await asyncio.shield(self._ui_ready_task)
        if method == "command/invoke":
            if not self._ui_negotiated or self._ui_ready_task is None:
                return {"ok": False, "error": {"code": "PLUGIN_E_UI_VERSION", "message": "UI is not ready.",
                        "detail": {"kind": "ui", "reason": "negotiation"}}}
            ready = await asyncio.shield(self._ui_ready_task)
            if not ready["ok"]:
                return ready
            try:
                validate_invocation(params)
            except SchemaError as error:
                raise RpcError(_INVALID_PARAMS, "Invalid command invocation.") from error
            try:
                return await self._context_commands.invoke(params)
            except SchemaError as error:
                raise RpcError(_INVALID_PARAMS, "Invalid context command arguments.") from error
        raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")

    async def _request(self, method: str, params: dict, timeout: float = 10):
        ui_epoch = self._ui_epoch if method.startswith("ui/") else None
        params = copy.deepcopy(params)
        device_epoch = self._device_epoch
        if recovery_request(method, params) and not self._recovery_ready:
            raise RpcError(_INVALID_REQUEST, "Connection recovery is not negotiated.")
        if (method.startswith("ui/data") or method == "ui/formPatch") and (self._ui_version != 2 or not self._ui_data_ready):
            raise RpcError(_INVALID_REQUEST, "UI v2 data is not ready.")
        self._validate_ui(method, "params", params)
        if not valid_wire(method, "params", params):
            raise RpcError(_INVALID_PARAMS, "Invalid UI parameters.")
        if method.startswith("ui/") and method not in ("ui/showMessage", "ui/copyText"): timeout = 5
        request_id = self._next_id
        self._next_id += 1
        future = self._loop.create_future()
        self._pending[request_id] = future
        self._pending_methods[request_id] = method
        if method.startswith("devices/") or method == "events/unsubscribe":
            self._device_inputs[request_id] = (method, copy.deepcopy(params), device_epoch)
        try:
            self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            reply = await asyncio.wait_for(future, timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._send({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":request_id}})
            raise
        finally:
            self._pending.pop(request_id, None)
            self._pending_methods.pop(request_id, None)
            self._device_inputs.pop(request_id, None)
        if (method.startswith("devices/") or method == "events/unsubscribe") and device_epoch != self._device_epoch:
            raise RpcError(_CANCELLED, "Device session retired.")
        # Check after the await, before interpreting either success or error
        # using the current session's schemas. Non-UI replies are unaffected.
        if ui_epoch is not None and ui_epoch != self._ui_epoch:
            raise RpcError(_CANCELLED, "UI session retired.")
        if "error" in reply:
            raise RpcError(reply["error"]["code"], reply["error"]["message"])
        self._validate_ui(method, "result", reply["result"], params)
        if not valid_wire(method, "result", reply["result"], params):
            raise RpcError(_INTERNAL, "Invalid UI result.")
        return reply["result"]

class _InvocationContext:
    def __init__(self, base, invocation):
        import copy
        object.__setattr__(self, "_base", base)
        object.__setattr__(self, "_invocation", copy.deepcopy(invocation))
        object.__setattr__(self, "actions", _InvocationActions(base.actions, invocation))

    @property
    def invocation(self):
        import copy
        return copy.deepcopy(self._invocation)

    def __getattr__(self, name):
        record = self.__dict__.get("_command_context")
        if record is not None and hasattr(record, name):
            return getattr(record, name)
        return getattr(self._base, name)

def create_invocation_context(base, invocation):
    return _InvocationContext(base, invocation)
