import asyncio
import copy
import unittest
from kobrixa._ui import Ui, valid_form_wire
from kobrixa._schema import Validator, SchemaError
from tests import test_ui_data_integration as fixture
BINDING = fixture.BINDING

PARAMS = {"binding": BINDING, "baseFormRevision": 0, "set": {"a": "-"}}
RESULT = {"ok": True, "value": {"formRevision": 1, "form": {"a": "-"}}}
STALE = {"ok": False, "error": {"code": "PLUGIN_E_STALE_RESOURCE", "message": "Stale form.",
          "detail": {"kind": "resource", "reason": "stale", "resource": "ui-binding"}}}

class FormWireTests(unittest.TestCase):
    def test_bounds_schema_and_semantics(self):
        validator = Validator.bundled()
        for count in (0, 33):
            params = {**PARAMS, "set": {f"f{i}": None for i in range(count)}}
            with self.assertRaises(SchemaError): validator.validate("ui/formPatch.params", params)
            self.assertFalse(valid_form_wire("params", params))
        self.assertTrue(valid_form_wire("params", {**PARAMS, "set": {f"f{i}": None for i in range(32)}}))
        fields = {k: "x" * 4000 for k in "abcd"}
        fields["e"] = "x" * 348
        self.assertTrue(valid_form_wire("params", {**PARAMS, "set": fields}))
        self.assertTrue(valid_form_wire("result", {"ok":True,"value":{"formRevision":1,"form":fields}}, {**PARAMS,"set":{"a":fields["a"]}}))
        fields["e"] += "x"
        self.assertFalse(valid_form_wire("result", {"ok":True,"value":{"formRevision":1,"form":fields}}, {**PARAMS,"set":{"a":fields["a"]}}))
        self.assertFalse(valid_form_wire("params", {**PARAMS, "set": fields}))
        for item in (float('inf'), float('nan'), "\ud800", "\0", "x" * 4001, 10 ** 400):
            self.assertFalse(valid_form_wire("params", {**PARAMS, "set": {"a": item}}))
        for key in ("constructor", "prototype", "__proto__"):
            self.assertFalse(valid_form_wire("params", {**PARAMS, "set": {key: 1}}))
        self.assertTrue(valid_form_wire("result", RESULT, PARAMS))
        for patch in ({"formRevision": 2}, {"form": {}}, {"form": {"a": "old"}}):
            self.assertFalse(valid_form_wire("result", {"ok": True, "value": {**RESULT["value"], **patch}}, PARAMS))
        self.assertFalse(valid_form_wire("result", {"ok": True, "value": {"formRevision": 1, "form": {"a": True}}}, {**PARAMS,"set":{"a":1}}))

class FormFacadeTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_call_readiness_stale_and_snapshot(self):
        calls = []
        async def request(method, params, timeout):
            calls.append((method, params, timeout))
            return STALE
        ui = Ui(request, object())
        with self.assertRaisesRegex(RuntimeError, "not ready"): await ui.form_patch(BINDING, 0, {"a":"-"})
        ui.mark_ready()
        with self.assertRaisesRegex(RuntimeError, "not ready"): await ui.form_patch(BINDING, 0, {"a":"-"})
        ui.mark_ready(2)
        self.assertEqual(await ui.form_patch(BINDING, 0, {"a":"-"}), STALE)
        self.assertEqual(calls, [("ui/formPatch", PARAMS, 5)])

    async def test_pending_copy_retirement_and_cancellation(self):
        start, finish = asyncio.Event(), asyncio.Event()
        async def request(method, params, timeout):
            start.set()
            await finish.wait()
            return copy.deepcopy(RESULT)
        ui = Ui(request, object()); ui.mark_ready(2)
        fields = {"a":"-"}
        task = asyncio.create_task(ui.form_patch(BINDING, 0, fields))
        await start.wait(); fields["a"] = "new"; finish.set()
        self.assertEqual(await task, RESULT)
        start.clear(); finish.clear()
        task = asyncio.create_task(ui.form_patch(BINDING, 0, {"a":"-"}))
        await start.wait(); ui.retire(); ui.mark_ready(2); finish.set()
        with self.assertRaisesRegex(RuntimeError,"retired"): await task
        start.clear(); finish.clear()
        task = asyncio.create_task(ui.form_patch(BINDING, 0, {"a":"-"}))
        await start.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task

class FormPortTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixture.UiDataIntegrationTests.asyncSetUp
    messages = fixture.UiDataIntegrationTests.messages
    handle = fixture.UiDataIntegrationTests.handle
    initialized = fixture.UiDataIntegrationTests.initialized
    ready = fixture.UiDataIntegrationTests.ready
    reply = fixture.UiDataIntegrationTests.reply
    async def test_form_real_port_versions_correlation_and_frames(self):
        for version in ("1.6.0", "1.7.0"):
            await self.initialized(version,[1,2]); await self.handle("ui/ready",{})
            with self.assertRaisesRegex(RuntimeError,"not ready"):
                await self.plugin.ui.form_patch(BINDING,0,{"a":"-"})
            with self.assertRaisesRegex(Exception,"not ready"):
                await self.plugin._request("ui/formPatch", PARAMS)
        await self.ready()
        task = asyncio.create_task(self.plugin.ui.form_patch(BINDING,0,{"a":"-"}))
        self.assertEqual(await self.reply(task, STALE), STALE)
        task = asyncio.create_task(self.plugin.ui.form_patch(BINDING,0,{"a":"-"}))
        self.assertEqual(await self.reply(task, RESULT, 65536), RESULT)
        for error in (False, True):
            task = asyncio.create_task(self.plugin.ui.form_patch(BINDING,0,{"a":"-"}))
            with self.assertRaisesRegex(Exception,"64 KiB"):
                await self.reply(task, RESULT, 65537, error)
        task = asyncio.create_task(self.plugin.ui.form_patch(BINDING,0,{"a":"-"}))
        with self.assertRaises(SchemaError):
            await self.reply(task,{"ok":True,"value":{"formRevision":2,"form":{"a":"-"}}})

    async def test_form_outgoing_entire_error_frame(self):
        self.plugin._incoming_methods[1] = "ui/formPatch"
        with self.assertRaisesRegex(Exception,"64 KiB"):
            self.plugin._send({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"界" * 22000}})
        self.assertEqual(self.plugin._output.getvalue(),b"")
