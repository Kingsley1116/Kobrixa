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

API_VERSION = "1.5.0"
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
        self.ui = _Ui(plugin)
        self.devices = plugin.devices


class Plugin:
    def __init__(self) -> None:
        self.plugin_id = ""
        self.locale = "en"
        self.devices = Devices(self._request)
        launch_owner = os.environ.get("KOBRIXA_RESOURCE_OWNER")
        if launch_owner is not None:
            bind_event_channel(self, json.loads(launch_owner, parse_constant=_reject_json_constant))
        self._commands = {}
        self._tasks = {}
        self._pending = {}
        self._next_id = 1
        self._validator = Validator.bundled()
        self._stopping = False
        self._output = sys.stdout.buffer
        # Reserve real stdout for protocol frames before any top-level print() after Plugin().
        sys.stdout = sys.stderr

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
        self._stopping = True  # Nothing is sent after exit or EOF, including cancellation replies.
        close_event_channel(self)
        for task in list(self._tasks.values()):
            task.cancel()

    def _send(self, message: dict) -> None:
        if self._stopping:
            return
        try:
            remaining = memoryview(encode(json.dumps(
                message, ensure_ascii=True, separators=(",", ":")
            )))
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
            message = json.loads(text, parse_constant=_reject_json_constant)
            self._validator.validate("message", message)
            if "method" in message and "id" in message:
                request_id, method = message["id"], message["method"]
                if request_id in self._tasks:
                    self._send({"jsonrpc": "2.0", "id": request_id,
                                "error": {"code": _INVALID_REQUEST,
                                          "message": "Duplicate request id."}})
                    return
                task = asyncio.ensure_future(self._handle(message))
                self._tasks[request_id] = task
                task.add_done_callback(lambda done: self._finished(request_id, method, done))
            elif "method" in message:
                method, params = message["method"], message.get("params")
                if not self._validator.has(f"{method}.params"):
                    raise SchemaError(f"Unknown notification {method}.")
                self._validator.validate(f"{method}.params", params)
                if method == "$/cancelRequest":
                    task = self._tasks.get(params["id"])
                    if task:
                        task.cancel()
                elif method == "events/deliver":
                    self.devices.inbox.accept(params) if self.devices.inbox is not None else None
                elif method == "exit":
                    close_event_channel(self)
                    self._stopping = True
            else:
                future = self._pending.pop(message["id"], None)
                if future and not future.done():
                    future.set_result(message)
        except (ValueError, SchemaError) as error:
            print(f"kobrixa: ignored invalid message from host: {error}", file=sys.stderr)
        except Exception as error:  # noqa: BLE001 - one bad message must not stop the transport
            print(f"kobrixa: failed to process message from host: {error}", file=sys.stderr)

    async def _handle(self, message: dict) -> None:
        request_id, method = message["id"], message["method"]
        try:
            if not self._validator.has(f"{method}.params") or method == "ui/showMessage":
                raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")
            params = message.get("params")
            try:
                self._validator.validate(f"{method}.params", params)
            except SchemaError as error:
                raise RpcError(_INVALID_PARAMS, f"Invalid parameters for {method}: {error}") from error
            result = await self._dispatch(method, params)
            self._send({"jsonrpc": "2.0", "id": request_id, "result": result})
        except asyncio.CancelledError:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _CANCELLED, "message": f"{method} was cancelled."}})
        except RpcError as error:
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": error.code, "message": str(error)[:2000]}})
        except Exception as error:  # noqa: BLE001 - report handler failures to the host
            self._send({"jsonrpc": "2.0", "id": request_id,
                        "error": {"code": _INTERNAL, "message": str(error)[:2000] or type(error).__name__}})

    async def _dispatch(self, method: str, params: dict):
        if method == "initialize":
            self.plugin_id, self.locale = params["pluginId"], params["locale"]
            asyncio.get_running_loop().call_soon(self.devices.initialized, params["apiVersion"])
            return {"apiVersion": API_VERSION, "sdk": {"name": "kobrixa-plugin-sdk", "version": SDK_VERSION}}
        if method == "command/execute":
            handler = self._commands.get(params["command"])
            if handler is None:
                raise RpcError(_INVALID_PARAMS, f"The plugin did not register {params['command']}.")
            await handler(CommandContext(self))
            return None
        if method == "shutdown":
            return None
        raise RpcError(_METHOD_NOT_FOUND, f"Unknown method {method}.")

    async def _request(self, method: str, params: dict, timeout: float = 10):
        self._validator.validate(f"{method}.params", params)
        request_id = self._next_id
        self._next_id += 1
        future = self._loop.create_future()
        self._pending[request_id] = future
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            reply = await asyncio.wait_for(future, timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self._send({"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":request_id}})
            raise
        finally:
            self._pending.pop(request_id, None)
        if "error" in reply:
            raise RpcError(reply["error"]["code"], reply["error"]["message"])
        self._validator.validate(f"{method}.result", reply["result"])
        return reply["result"]
