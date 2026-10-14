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
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import Mock
from kobrixa import Plugin
from kobrixa._framing import Decoder, encode

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
            "apiVersion": "1.0.0", "pluginId": "acme.behaviors", "locale": "zh-TW",
            "grantedPermissions": ["ui.notifications"]}})
        reply = self.receive()
        self.assertEqual(reply["result"]["apiVersion"], "1.0.0")

    def test_command_round_trip_with_print_redirected(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 2, "method": "command/execute",
                   "params": {"command": "acme.behaviors.greet"}})
        request = self.receive()
        self.assertEqual(request["method"], "ui/showMessage")
        self.assertEqual(request["params"], {"severity": "info", "message": "acme.behaviors:zh-TW"})
        self.send({"jsonrpc": "2.0", "id": request["id"], "result": None})
        self.assertEqual(self.receive(), {"jsonrpc": "2.0", "id": 2, "result": None})

    def test_cancellation_reports_request_cancelled(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "id": 3, "method": "command/execute",
                   "params": {"command": "acme.behaviors.hang"}})
        self.send({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 3}})
        self.assertEqual(self.receive()["error"]["code"], -32800)

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
