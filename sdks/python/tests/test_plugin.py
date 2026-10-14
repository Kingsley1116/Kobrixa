import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
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

    def tearDown(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait(5)
        for stream in (self.child.stdin, self.child.stdout, self.child.stderr):
            stream.close()

    def send(self, message):
        self.child.stdin.write(encode(json.dumps(message)))
        self.child.stdin.flush()

    def receive(self):
        while not self.pending:
            chunk = self.child.stdout.read1(65536)
            self.assertTrue(chunk, "plugin closed stdout")
            self.pending += self.decoder.push(chunk)
        return json.loads(self.pending.pop(0))

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

    def test_exits_on_exit_notification_and_on_stdin_eof(self):
        self.initialize()
        self.send({"jsonrpc": "2.0", "method": "exit", "params": {}})
        self.assertEqual(self.child.wait(5), 0)

    def test_exits_when_host_disappears(self):
        self.initialize()
        self.child.stdin.close()
        self.assertEqual(self.child.wait(5), 0)
