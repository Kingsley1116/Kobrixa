import asyncio
import io
import json
import os
import queue
import subprocess
import sys
import threading
import time
import unittest
from collections import deque
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock
from kobrixa import Plugin
from kobrixa._framing import Decoder, encode
from kobrixa._plugin import _CANCELLED

SDK = Path(__file__).resolve().parents[1]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "behaviors.py"


class PluginProcessTest(unittest.TestCase):
    def setUp(self):
        env = {**os.environ, "PYTHONPATH": str(SDK), "PYTHONUNBUFFERED": "1"}
        self.child = subprocess.Popen([sys.executable, str(FIXTURE)], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        self.decoder = Decoder()
        self.pending = []
        self.next_followup_id = 100
        self.stdout_chunks = queue.Queue()
        self.stderr_chunks = deque(maxlen=32)

        def drain(stream, consume):
            while True:
                chunk = stream.read1(65536)
                consume(chunk)
                if not chunk:
                    return

        self.readers = [
            threading.Thread(target=drain, args=(self.child.stdout, self.stdout_chunks.put), daemon=True),
            threading.Thread(target=drain, args=(self.child.stderr, self.stderr_chunks.append), daemon=True),
        ]
        self.addCleanup(self.stop_child)
        for reader in self.readers:
            reader.start()

    def stop_child(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(5)
        for reader in self.readers:
            reader.join(5)
        for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
            try:
                stream.close()
            except BrokenPipeError:
                pass  # A failed write may still be buffered after the child exits.

    def send(self, message):
        self.send_raw(json.dumps(message))

    def send_raw(self, *messages):
        self.child.stdin.write(b"".join(encode(message) for message in messages))
        self.child.stdin.flush()

    def stderr_text(self):
        return b"".join(self.stderr_chunks).decode("utf-8", errors="replace")

    def receive(self, timeout=10):
        deadline = time.monotonic() + timeout
        while not self.pending:
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                chunk = self.stdout_chunks.get(timeout=remaining)
            except queue.Empty:
                self.fail(f"timed out waiting for plugin output after {timeout}s\n{self.stderr_text()}")
            if not chunk:
                self.readers[1].join(5)
                self.fail(f"plugin closed stdout\n{self.stderr_text()}")
            self.pending += self.decoder.push(chunk)
        return json.loads(self.pending.pop(0))

    def assert_ignored_and_alive(self, text):
        # Batch the follow-up to avoid racing the old plugin's crash with a second write.
        request_id = self.next_followup_id
        self.next_followup_id += 1
        self.send_raw(text, json.dumps({"jsonrpc": "2.0", "id": request_id,
                                        "method": "shutdown", "params": {}}))
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": request_id, "result": None})
        self.assertIsNone(self.child.poll(), self.stderr_text())

    def initialize(self):
        self.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "apiVersion": "1.1.0", "pluginId": "acme.behaviors", "locale": "zh-TW",
            "grantedPermissions": ["ui.notifications"]}})
        reply = self.receive()
        self.assertEqual(reply["result"]["apiVersion"], "1.7.0")

    def test_command_round_trip_with_print_redirected(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 2, "method": "command/execute",
                   "params": {"command": "acme.behaviors.greet"}})
        request = self.receive()
        self.assertEqual(request["method"], "ui/showMessage")
        self.assertEqual(request["params"], {"severity": "info", "message": "acme.behaviors:zh-TW"})
        self.send({"jsonrpc": "2.0", "id": request["id"], "result": None})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 2, "result": None})

    def test_top_level_print_before_run_preserves_protocol_stdout(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "method": "exit", "params": {}})
        self.assertEqual(self.child.wait(5), 0)
        self.readers[1].join(5)
        self.assertIn("top-level output before run", self.stderr_text())

    def test_cancellation_reports_request_cancelled(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 3, "method": "command/execute",
                   "params": {"command": "acme.behaviors.hang"}})
        self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 3}})
        self.assertEqual(self.receive()["error"]["code"], -32800)

    def test_duplicate_request_id_leaves_original_request_cancellable(self):
        self.initialize()
        request = {"jsonrpc": "2.0", "id": 3, "method": "command/execute",
                   "params": {"command": "acme.behaviors.greet"}}
        self.send(request)
        self.assertEqual(self.receive()["method"], "ui/showMessage")
        self.send(request)
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 3, "error": {
            "code": -32600, "message": "Duplicate request id."}})
        self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 3}})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 1}})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 3, "error": {
            "code": _CANCELLED, "message": "command/execute was cancelled."}})

    def test_cancel_before_start_replies_exactly_once(self):
        self.initialize()
        # Both frames arrive in one chunk, so the task is cancelled before it ever runs.
        self.child.stdin.write(
            encode(json.dumps({"jsonrpc": "2.0", "id": 6, "method": "command/execute",
                               "params": {"command": "acme.behaviors.hang"}}))
            + encode(json.dumps({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 6}})))
        self.child.stdin.flush()
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 6, "error": {
            "code": -32800, "message": "command/execute was cancelled."}})
        # The next reply must belong to the next request: no duplicate reply for id 6.
        self.send({"jsonrpc": "2.0", "id": 7, "method": "command/execute",
                   "params": {"command": "acme.behaviors.missing"}})
        self.assertEqual(self.receive()["id"], 7)

    def test_unknown_command_and_invalid_params(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 4, "method": "command/execute",
                   "params": {"command": "acme.behaviors.missing"}})
        self.assertEqual(self.receive()["error"]["code"], -32602)
        self.send({"jsonrpc": "2.0", "id": 5, "method": "command/execute", "params": {"command": 1}})
        self.assertEqual(self.receive()["error"]["code"], -32602)

    def test_huge_integer_request_id_does_not_crash(self):
        self.initialize()
        self.assert_ignored_and_alive(json.dumps({"jsonrpc": "2.0", "id": 10 ** 399,
                                                  "method": "shutdown", "params": {}}))

    def test_unhashable_cancel_id_does_not_crash(self):
        self.initialize()
        self.assert_ignored_and_alive(json.dumps({"jsonrpc": "2.0", "method": "$/cancelRequest",
                                                  "params": {"id": [1]}}))

    def test_exit_notification_with_extra_params_is_ignored(self):
        self.initialize()
        self.assert_ignored_and_alive(json.dumps({"jsonrpc": "2.0", "method": "exit",
                                                  "params": {"extra": True}}))

    def test_exit_notification_without_params_is_ignored(self):
        self.initialize()
        self.assert_ignored_and_alive(json.dumps({"jsonrpc": "2.0", "method": "exit"}))

    def test_nonstandard_json_constants_are_rejected(self):
        self.initialize()
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                self.assert_ignored_and_alive(
                    '{"jsonrpc":"2.0","id":2,"method":"shutdown","params":{"value":'
                    + constant + '}}')

    def test_receive_times_out_when_plugin_is_silent(self):
        with self.assertRaisesRegex(AssertionError, "timed out waiting for plugin output"):
            self.receive(timeout=0.05)
        self.initialize()

    def test_stderr_output_cannot_block_the_plugin(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 2, "method": "command/execute",
                   "params": {"command": "acme.behaviors.noisy"}})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 2, "result": None})

    def test_exits_on_exit_notification_and_on_stdin_eof(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "method": "exit", "params": {}})
        self.assertEqual(self.child.wait(5), 0)

    def test_exits_when_host_disappears(self):
        self.initialize()
        self.child.stdin.close()
        self.assertEqual(self.child.wait(5), 0)


class PluginReceiveTest(unittest.TestCase):
    def setUp(self):
        self.output = io.BytesIO()
        redirect = redirect_stdout(io.TextIOWrapper(self.output, encoding="utf-8"))
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def test_send_retries_partial_and_temporarily_unavailable_writes(self):
        class PartialOutput(io.RawIOBase):
            def __init__(self, unavailable):
                self.data = bytearray()
                self.writes = 0
                self.flushes = 0
                self.unavailable = unavailable

            def write(self, data):
                self.writes += 1
                if self.writes == 2:
                    return self.unavailable
                size = min(3, len(data))
                self.data.extend(data[:size])
                return size

            def flush(self):
                self.flushes += 1

        plugin = Plugin()
        message = {"jsonrpc": "2.0", "id": 1, "result": "完整 frame"}
        for unavailable in (None, 0):
            with self.subTest(unavailable=unavailable):
                output = PartialOutput(unavailable)
                plugin._output = output
                plugin._send(message)
                self.assertEqual([json.loads(text) for text in Decoder().push(bytes(output.data))],
                                 [message])
                self.assertEqual(output.flushes, 1)

    def test_send_preserves_lone_surrogate_and_keeps_answering(self):
        plugin = Plugin()
        message = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "bad \ud800"}}
        plugin._output = self.output
        plugin._send(message)
        self.assertFalse(plugin._stopping)
        followup = {"jsonrpc": "2.0", "id": 2, "result": None}
        plugin._send(followup)
        self.assertEqual([json.loads(text) for text in Decoder().push(self.output.getvalue())],
                         [message, followup])

    def test_only_os_errors_stop_sending(self):
        plugin = Plugin()
        plugin._output = Mock()
        plugin._output.write.side_effect = ValueError("invalid output")
        with self.assertRaises(ValueError):
            plugin._send({"jsonrpc": "2.0", "id": 1, "result": None})
        self.assertFalse(plugin._stopping)
        plugin._output.write.side_effect = BrokenPipeError("closed pipe")
        plugin._send({"jsonrpc": "2.0", "id": 2, "result": None})
        self.assertTrue(plugin._stopping)

    def test_finished_only_removes_its_own_task(self):
        plugin = Plugin()
        original, replacement = Mock(), Mock()
        original.cancelled.return_value = False
        replacement.cancelled.return_value = False
        plugin._tasks[1] = replacement
        plugin._finished(1, "command/execute", original)
        self.assertIs(plugin._tasks.get(1), replacement)
        plugin._finished(1, "command/execute", replacement)
        self.assertNotIn(1, plugin._tasks)

    def test_invalid_cancel_params_are_logged_without_cancelling_tasks(self):
        plugin = Plugin()
        task = Mock()
        plugin._tasks[1] = task
        for params in ({"id": [1]}, {"id": {}}, {"id": True}, {"id": 1, "extra": True}, {}):
            with self.subTest(params=params), redirect_stderr(io.StringIO()) as stderr:
                plugin._receive(json.dumps({"jsonrpc": "2.0", "method": "$/cancelRequest",
                                            "params": params}))
                task.cancel.assert_not_called()
                self.assertIn("invalid", stderr.getvalue())

    def test_unexpected_receive_exception_is_logged_and_next_message_is_processed(self):
        plugin = Plugin()
        future = Mock()
        future.done.return_value = False
        plugin._pending = Mock()
        plugin._pending.pop.side_effect = [RuntimeError("injected receive failure"), future]
        message = {"jsonrpc": "2.0", "id": 1, "result": None}
        with redirect_stderr(io.StringIO()) as stderr:
            plugin._receive(json.dumps(message))
        self.assertIn("injected receive failure", stderr.getvalue())
        plugin._receive(json.dumps(message))
        future.set_result.assert_called_once_with(message)

class UiHandshakeTests(unittest.IsolatedAsyncioTestCase):
    async def test_negotiate_ready_and_legacy(self):
        import sys
        from kobrixa import Plugin
        original = sys.stdout
        plugin = Plugin()
        sys.stdout = original
        calls = []
        @plugin.command("acme.ui.old")
        async def old(ctx):
            calls.append("old")
        @plugin.ready
        async def ready(ctx):
            calls.append("ready")
        try:
            await plugin._dispatch("initialize", {"apiVersion": "1.6.0", "pluginId": "acme.ui",
                                                   "locale": "en", "grantedPermissions": ["ui.panels"]})
            self.assertFalse((await plugin._dispatch("ui/ready", {}))["ok"])
            await plugin._dispatch("ui/negotiate", {"commandEnvelopeVersions": [1], "uiResourceVersions": [1]})
            self.assertTrue((await plugin._dispatch("ui/ready", {}))["ok"])
            self.assertTrue((await plugin._dispatch("ui/ready", {}))["ok"])
            self.assertIsNone(await plugin._dispatch("command/execute", {"command": "acme.ui.old"}))
            self.assertEqual(calls, ["ready", "old"])
        finally:
            sys.stdout = original

class InvocationFactoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_overlapping_contexts_are_isolated(self):
        from types import SimpleNamespace
        from kobrixa import create_invocation_context
        base = SimpleNamespace(plugin_id="acme.ui", actions=SimpleNamespace())
        first = {"context": {"actionRef": "first"}}
        a = create_invocation_context(base, first)
        b = create_invocation_context(base, {"context": {"actionRef": "second"}})
        c = create_invocation_context(base, {"context": {}})
        first["context"]["actionRef"] = "changed"
        seen = []
        async def read(context):
            await asyncio.sleep(0)
            seen.append(context.invocation["context"].get("actionRef"))
        await asyncio.gather(read(b), read(a), read(c))
        self.assertEqual(seen, ["second", "first", None])
        a.invocation["context"]["actionRef"] = "changed again"
        self.assertEqual(a.invocation["context"]["actionRef"], "first")
        self.assertEqual(base.plugin_id, "acme.ui")
        self.assertFalse(hasattr(base.actions, "actionRef"))
        for context in (base, a, b, c):
            for name in ("settings", "storage", "drain"):
                self.assertFalse(hasattr(context, name))

    async def test_panel_dispatch_uses_factory_with_nested_immutable_context(self):
        from kobrixa import Plugin
        from tests.test_commands import invocation
        original = sys.stdout
        plugin = Plugin()
        sys.stdout = original
        seen = []
        @plugin.context_command("acme.ui.run")
        async def command(ctx):
            seen.append(ctx.invocation)
            self.assertIs(ctx.ui, plugin.ui)
            self.assertIs(ctx.devices, plugin.devices)
            self.assertEqual(ctx.plugin_id, "acme.ui")
            self.assertEqual(ctx.command, "acme.ui.run")
            self.assertEqual(ctx.version, 1)
            self.assertEqual(ctx.invocation_id, ctx.invocation["invocationId"])
            self.assertEqual(dict(ctx.arguments), {})
            self.assertEqual(set(vars(ctx._base)), {"plugin_id", "locale", "ui", "devices", "settings", "storage", "actions"})
            self.assertEqual(set(vars(ctx._command_context)), {"version", "invocation_id", "command", "arguments", "context"})
            with self.assertRaises(TypeError):
                ctx.context["form"]["values"]["field"] = "changed"
            self.assertEqual(ctx.context["form"]["values"]["field"], "value")
            return {"output": {}, "fieldErrors": []}
        try:
            await plugin._dispatch("initialize", {"apiVersion":"1.6.0", "pluginId":"acme.ui", "locale":"en", "grantedPermissions":[]})
            await plugin._dispatch("ui/negotiate", {"commandEnvelopeVersions":[1], "uiResourceVersions":[1]})
            await plugin._dispatch("ui/ready", {})
            call = invocation()
            call["context"]["origin"] = "panel"
            call["context"]["binding"] = {"contributionId":"acme.ui.panel", "panelInstance":call["invocationId"], "kind":"panel", "uiResourceGeneration":1, "generation":1, "hostEpoch":call["invocationId"], "processEpoch":call["invocationId"]}
            call["context"]["form"] = {"revision":0,"values":{"field":"value"}}
            result = await plugin._dispatch("command/invoke", call)
            self.assertTrue(result["ok"], result)
            self.assertEqual(seen, [call])
        finally:
            sys.stdout = original

class PersistenceContextTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.output = io.BytesIO()
        self.redirect = redirect_stdout(io.TextIOWrapper(self.output, encoding="utf-8"))
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    async def test_clients_preserve_wire_keys_business_errors_and_unwatch(self):
        from kobrixa._plugin import CommandContext
        plugin = Plugin()
        calls = []
        result = {"ok": False, "error": {"code": "PLUGIN_E_SETTINGS_CONFLICT",
            "message": "Revision changed", "detail": {"kind": "persistence", "reason": "revision-mismatch"}}}
        async def request(method, params, **options):
            calls.append((method, params))
            if method == "events/unsubscribe":
                return {"ok":True,"value":{"removed":True}}
            return result
        plugin._request = request
        ctx = CommandContext(plugin)
        params = {"schemaVersion": 1, "expectedRevision": None,
                  "changes": [{"key": "fixture.enabled", "value": True}]}
        self.assertEqual(await ctx.settings.update(params), result)
        self.assertEqual(calls[-1], ("settings/update", params))
        await ctx.settings.unwatch({"subscriptionId": "11111111-1111-4111-8111-111111111111"})
        self.assertEqual(calls[-1][0], "events/unsubscribe")
        self.assertFalse(hasattr(ctx.actions, "actionRef"))

    async def test_actions_copy_only_action_ref_and_never_invocation_id(self):
        from kobrixa._plugin import CommandContext, create_invocation_context
        plugin = Plugin()
        base = CommandContext(plugin)
        invocation = {"invocationId":"11111111-1111-4111-8111-111111111111", "context":{}}
        self.assertFalse(hasattr(create_invocation_context(base, invocation).actions, "actionRef"))
        invocation["context"]["actionRef"] = "22222222-2222-4222-8222-222222222222"
        first = create_invocation_context(base, invocation)
        invocation["context"]["actionRef"] = "33333333-3333-4333-8333-333333333333"
        second = create_invocation_context(base, invocation)
        self.assertEqual(first.actions.actionRef, "22222222-2222-4222-8222-222222222222")
        self.assertEqual(second.actions.actionRef, "33333333-3333-4333-8333-333333333333")
        with self.assertRaises(AttributeError):
            first.actions.actionRef = "forged"
        self.assertFalse(hasattr(base.actions, "actionRef"))

    async def test_old_host_or_missing_callback_cannot_dispatch_drain(self):
        from kobrixa import RpcError
        request = {"token": "11111111-1111-4111-8111-111111111111", "reason": "shutdown",
                   "remainingMs": 10000, "checkpoints": [], "writes": []}
        for version in ("1.4.0", "1.5.0", "1.6.0", "1.7.0"):
            plugin = Plugin()
            plugin._host_api_version = version
            with self.assertRaises(RpcError) as error:
                await plugin._dispatch("storage/drain", request)
            self.assertEqual(error.exception.code, -32601)

    async def test_drain_is_independent_of_an_ordinary_cancelled_task(self):
        import asyncio
        plugin = Plugin()
        plugin._host_api_version = "1.7.0"
        calls = []
        @plugin.drain
        async def drain(ctx):
            calls.append(ctx.request["token"])
            return {"ok": True, "value": {"status": "checkpoint-only", "writes": []}}
        ordinary = asyncio.create_task(asyncio.sleep(100))
        ordinary.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await ordinary
        request = {"token": "11111111-1111-4111-8111-111111111111", "reason": "shutdown",
                   "remainingMs": 10000, "checkpoints": [], "writes": []}
        result = await plugin._dispatch("storage/drain", request)
        self.assertEqual(result["value"]["status"], "checkpoint-only")
        self.assertEqual(calls, [request["token"]])

    async def test_registered_drain_still_requires_a_negotiated_host(self):
        from kobrixa import RpcError
        plugin = Plugin()
        calls = []
        @plugin.drain
        async def drain(ctx):
            calls.append(ctx.request)
            return {"ok": True, "value": {"status": "submitted", "writes": []}}
        for version in ("0.0.0", "1.4.0", "1.5.0", "1.6.0"):
            plugin._host_api_version = version
            with self.subTest(version=version), self.assertRaises(RpcError) as error:
                await plugin._dispatch("storage/drain", {"token": "11111111-1111-4111-8111-111111111111",
                    "reason": "shutdown", "remainingMs": 10000, "checkpoints": [], "writes": []})
            self.assertEqual(error.exception.code, -32601)
        self.assertEqual(calls, [])
        with self.assertRaises(ValueError):
            plugin.drain(drain)
        with self.assertRaises(TypeError):
            Plugin().drain(lambda ctx: None)

    async def test_persistence_does_not_convert_or_retry_legacy_permission_errors(self):
        from kobrixa import RpcError
        from kobrixa._plugin import CommandContext
        plugin = Plugin()
        calls = []
        async def request(method, params):
            calls.append(method)
            raise RpcError(-32002, "Denied")
        plugin._request = request
        with self.assertRaises(RpcError) as error:
            await CommandContext(plugin).settings.read({"schemaVersion": 1})
        self.assertEqual(error.exception.code, -32002)
        self.assertEqual(calls, ["settings/read"])
