import asyncio
import copy
import io
import json
import sys
import unittest

from kobrixa._plugin import Plugin, RpcError
from kobrixa._schema import SchemaError
from kobrixa._framing import Decoder
from kobrixa._ui_v2_data import UiDataValidationError

ID = "00000000-0000-4000-8000-000000000001"
BINDING = {"contributionId": "test.lab.panel", "panelInstance": ID, "kind": "panel",
           "uiResourceGeneration": 1, "generation": 1, "hostEpoch": ID, "processEpoch": ID}
READ = {"binding": BINDING, "dataset": "code", "revision": 1, "offset": 0, "limit": 1}
PAGE = {"ok": True, "value": {"revision": 1, "presentation": 1, "byteLength": 20, "sha256": "a" * 64,
        "header": {"kind": "code"}, "chunk": {"kind": "code", "entries": ["α"]}, "nextOffset": 1, "done": True}}


class UiDataIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved = sys.stdout
        try:
            self.plugin = Plugin()
        finally:
            sys.stdout = saved
        self.plugin._loop = asyncio.get_running_loop()
        self.plugin._output = io.BytesIO()

    def messages(self):
        return [json.loads(s) for s in Decoder().push(self.plugin._output.getvalue())]

    async def handle(self, method, params):
        await self.plugin._handle({"jsonrpc": "2.0", "id": 99, "method": method, "params": params})
        return self.messages()[-1]

    async def initialized(self, version="1.8.0", versions=None):
        await self.handle("initialize", {"apiVersion": version, "pluginId": "test.lab", "locale": "en", "grantedPermissions": []})
        return await self.handle("ui/negotiate", {"commandEnvelopeVersions": [1], "uiResourceVersions": [2] if versions is None else versions})

    async def ready(self):
        await self.initialized()
        await self.handle("ui/ready", {})

    async def reply(self, task, result=None, raw_size=None, error=False):
        await asyncio.sleep(0)
        message = self.messages()[-1]
        body = {"jsonrpc": "2.0", "id": message["id"]}
        body.update({"error": {"code": -32603, "message": "bad"}} if error else {"result": result})
        wire = json.dumps(body, ensure_ascii=True)
        if raw_size is not None:
            wire += " " * (raw_size - len(wire.encode("utf-8")))
        self.plugin._receive(wire)
        return await task

    async def test_old_initialize_never_selects_v2_and_candidate_intersections(self):
        for version in ("1.6.0", "1.7.0"):
            result = await self.initialized(version, [1, 2])
            self.assertEqual(result["result"]["value"]["uiResourceVersions"], [1])
            await self.handle("ui/ready", {})
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                await self.plugin.ui.data.snapshot(BINDING)
        for offered in ([], [1], [2], [1, 2]):
            result = await self.initialized(versions=offered)
            self.assertEqual(result["result"]["value"]["uiResourceVersions"], offered)
        for malformed in ([2, 1], [2, 2], [3]):
            reply = await self.handle("ui/negotiate", {"commandEnvelopeVersions": [1], "uiResourceVersions": malformed})
            self.assertEqual(reply["error"]["code"], -32602)

    async def test_structural_and_correlated_read_validation_on_actual_port(self):
        await self.ready()
        for change in ({"revision": 2}, {"nextOffset": 2}, {"unexpected": True}, {"chunk": {"kind": "code", "entries": []}, "done": False}):
            page = copy.deepcopy(PAGE)
            page["value"].update(change)
            params = copy.deepcopy(READ)
            task = asyncio.create_task(self.plugin.ui.data.read(params))
            await asyncio.sleep(0)
            params["revision"] = 2
            with self.assertRaises((SchemaError, UiDataValidationError)):
                await self.reply(task, page)
        task = asyncio.create_task(self.plugin.ui.data.read(READ))
        self.assertEqual(await self.reply(task, PAGE, 65536), PAGE)

    async def test_original_whitespace_and_error_envelope_budget(self):
        await self.ready()
        for error in (False, True):
            task = asyncio.create_task(self.plugin.ui.data.read(READ))
            with self.assertRaisesRegex(RpcError, "64 KiB"):
                await self.reply(task, PAGE, 65537, error)
        self.assertEqual(self.plugin._pending, {})
        self.assertEqual(self.plugin._pending_methods, {})

    async def test_send_counts_actual_utf8_and_entire_error_envelope(self):
        self.plugin._incoming_methods[1] = "ui/dataRead"
        with self.assertRaisesRegex(RpcError, "64 KiB"):
            self.plugin._send({"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "界" * 22000}})
        self.assertEqual(self.plugin._output.getvalue(), b"")

    async def test_shutdown_retires_and_late_ready_failure_cannot_retire_new_epoch(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def callback(_context):
            started.set()
            await finish.wait()
            raise ValueError("old callback")
        self.plugin.ready(callback)
        await self.initialized()
        old = asyncio.create_task(self.handle("ui/ready", {}))
        await started.wait()
        await self.initialized()
        self.plugin._ready_callback = None
        await self.handle("ui/ready", {})
        finish.set()
        await old
        self.assertTrue(self.plugin._ui_data_ready)
        await self.handle("shutdown", {})
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            await self.plugin.ui.data.snapshot(BINDING)

    async def test_cancelled_ready_and_failed_callback_retire(self):
        started = asyncio.Event()
        async def callback(_context):
            started.set()
            await asyncio.Event().wait()
        self.plugin.ready(callback)
        await self.initialized()
        task = asyncio.create_task(self.handle("ui/ready", {}))
        await started.wait()
        inner = self.plugin._ui_ready_task
        task.cancel()
        await task
        self.assertFalse(self.plugin._ui_data_ready)
        inner.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await inner

    async def test_shared_event_inbox_and_v2_six_topic_snapshot(self):
        from kobrixa._events import bind_event_channel, close_event_channel
        owner = {"sourceKey": "builtin:test.lab", "pluginId": "test.lab", "generation": 1,
                 "hostEpoch": ID, "processEpoch": ID}
        bind_event_channel(self.plugin, owner)
        try:
            await self.ready()
            received = []
            task = asyncio.create_task(self.plugin.ui.subscribe(
                ["instances", "visibility", "environment", "form", "state", "data"], received.append, BINDING))
            snapshot = {"instances": [], "states": [], "locale": "en", "theme": "light",
                        "data": [{"binding": BINDING, "datasets": []}]}
            self.assertTrue((await self.reply(task, {"ok": True, "value": {
                "subscriptionId": ID, "sequence": 0, "snapshot": snapshot}}))["ok"])
            event = {"jsonrpc": "2.0", "method": "events/deliver", "params": {
                "version": 1, "subscriptionId": ID, "owner": owner, "sequence": 1,
                "delivery": "telemetry", "kind": "ui.data", "data": {
                    "binding": BINDING, "dataset": "code", "revision": 1, "presentation": 1}}}
            self.plugin._receive(json.dumps(event))
            await asyncio.sleep(0)
            self.assertEqual(len(received), 1)
            ack = self.messages()[-1]
            self.assertEqual(ack["method"], "events/ack")
            self.plugin._receive(json.dumps({"jsonrpc": "2.0", "id": ack["id"], "result": {
                "ok": True, "value": {"acknowledged": 1}}}))
            await asyncio.sleep(0)
            # Raw event padding is rejected before entering the same bus.
            event["params"]["sequence"] = 2
            wire = json.dumps(event)
            self.plugin._receive(wire + " " * (65537 - len(wire.encode())))
            await asyncio.sleep(0)
            self.assertEqual(len(received), 1)
            await self.ready()
            self.plugin._receive(json.dumps(event))
            await asyncio.sleep(0)
            self.assertEqual(len(received), 1)
        finally:
            close_event_channel(self.plugin)

    async def test_subscription_metadata_binding_matches_request(self):
        await self.ready()
        with self.assertRaisesRegex(SchemaError, "binding mismatch"):
            self.plugin._validate_ui("ui/subscribe", "result", {"ok": True, "value": {
                "subscriptionId": ID, "sequence": 0, "snapshot": {
                    "instances": [], "states": [], "locale": "en", "theme": "light",
                    "data": [{"binding": {**BINDING, "generation": 2}, "datasets": []}]}}},
                {"topics": ["data"], "binding": BINDING})

    async def test_subscription_retirement_before_adoption(self):
        from kobrixa._events import bind_event_channel, close_event_channel
        owner = {"sourceKey": "builtin:test.lab", "pluginId": "test.lab", "generation": 1,
                 "hostEpoch": ID, "processEpoch": ID}
        bind_event_channel(self.plugin, owner)
        snapshot = {"ok": True, "value": {"subscriptionId": ID, "sequence": 0,
                    "snapshot": {"instances": [], "states": [], "locale": "en", "theme": "light",
                                 "data": [{"binding": BINDING, "datasets": []}]}}}
        event = {"jsonrpc": "2.0", "method": "events/deliver", "params": {
            "version": 1, "owner": owner, "subscriptionId": ID, "sequence": 1,
            "delivery": "telemetry", "kind": "ui.data", "data": {
                "binding": BINDING, "dataset": "code", "revision": 1, "presentation": 1}}}
        try:
            for timing in ("delayed", "resolved"):
                for transition in ("ui/negotiate", "shutdown"):
                    with self.subTest(timing=timing, transition=transition):
                        await self.ready()
                        received = []
                        pending = asyncio.create_task(self.plugin.ui.subscribe(
                            ["data"], received.append, BINDING))
                        await asyncio.sleep(0)
                        request_id = self.messages()[-1]["id"]
                        reply = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": snapshot})
                        if timing == "resolved":
                            # Resolve the actual pending Future, then retire before
                            # its awaiting task resumes. No fake request port.
                            self.plugin._receive(reply)
                        await self.handle(transition, {} if transition == "shutdown" else {
                            "commandEnvelopeVersions": [1], "uiResourceVersions": [2]})
                        if timing == "delayed":
                            self.plugin._receive(reply)
                        outcome = (await asyncio.gather(pending, return_exceptions=True))[0]
                        self.assertIsInstance(outcome, (RpcError, RuntimeError))
                        self.assertIn("retired", str(outcome))
                        self.assertEqual(self.plugin._pending, {})
                        self.assertEqual(self.plugin._pending_methods, {})
                        await self.ready()
                        self.plugin._receive(json.dumps(event))
                        await asyncio.sleep(0)
                        self.assertEqual(received, [])
            # A fresh request still succeeds, while a different original owner is rejected.
            await self.ready()
            received = []
            pending = asyncio.create_task(self.plugin.ui.subscribe(["data"], received.append, BINDING))
            await self.reply(pending, snapshot)
            wrong = copy.deepcopy(event)
            wrong["params"]["owner"]["generation"] = 2
            self.plugin._receive(json.dumps(wrong))
            await asyncio.sleep(0)
            self.assertEqual(received, [])
            self.plugin._receive(json.dumps(event))
            await asyncio.sleep(0)
            self.assertEqual(len(received), 1)
            ack = self.messages()[-1]
            self.assertEqual(ack["method"], "events/ack")
            self.plugin._receive(json.dumps({"jsonrpc": "2.0", "id": ack["id"],
                "result": {"ok": True, "value": {"acknowledged": 1}}}))
            await asyncio.sleep(0)
        finally:
            close_event_channel(self.plugin)

    async def test_pending_ui_response_keeps_originating_session(self):
        for outcome in ("success", "malformed", "error"):
            with self.subTest(outcome=outcome):
                await self.ready()
                pending = asyncio.create_task(self.plugin._request("ui/instances", {}))
                await asyncio.sleep(0)
                request_id = self.messages()[-1]["id"]
                await self.ready()
                body = {"jsonrpc": "2.0", "id": request_id}
                if outcome == "error":
                    body["error"] = {"code": -32603, "message": "old session error"}
                else:
                    body["result"] = {"ok": True, "value": {"instances": []}} if outcome == "success" else {}
                self.plugin._receive(json.dumps(body))
                with self.assertRaisesRegex(RpcError, "retired") as caught:
                    await pending
                self.assertEqual(caught.exception.code, -32800)
                self.assertEqual(self.plugin._pending, {})
                self.assertEqual(self.plugin._pending_methods, {})
        # UI retirement does not invalidate an unrelated common-event acknowledgment.
        pending = asyncio.create_task(self.plugin._request("events/ack", {"subscriptionId": ID, "sequence": 1}))
        await asyncio.sleep(0)
        request_id = self.messages()[-1]["id"]
        await self.ready()
        result = {"ok": True, "value": {"acknowledged": 1}}
        self.plugin._receive(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}))
        self.assertEqual(await pending, result)
