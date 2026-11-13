import asyncio
import copy
import unittest
from kobrixa._commands import ContextCommands
from kobrixa._schema import SchemaError

def invocation(n=1):
    return {"version": 1, "invocationId": f"00000000-0000-4000-8000-{n:012d}",
            "command": "acme.ui.run", "arguments": {}, "context": {
                "contextRef": None, "origin": "management", "locale": "en",
                "actionRef": "00000000-0000-4000-8000-000000000099",
                "trigger": {"kind": "activate"}}}

class ContextCommandsTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_and_completed_dedupe_and_readonly_context(self):
        registry = ContextCommands(lambda: "acme.ui")
        gate = asyncio.Event()
        calls = []
        async def handler(ctx):
            calls.append(ctx.context["actionRef"])
            with self.assertRaises(TypeError):
                ctx.context["actionRef"] = ctx.invocation_id
            await gate.wait()
            return {"output": {}, "fieldErrors": []}
        registry.register("acme.ui.run", {}, handler)
        first = asyncio.create_task(registry.invoke(invocation()))
        second = asyncio.create_task(registry.invoke(invocation()))
        await asyncio.sleep(0)
        gate.set()
        self.assertEqual(await first, await second)
        self.assertEqual(await registry.invoke(invocation()), await first)
        self.assertEqual(calls, ["00000000-0000-4000-8000-000000000099"])

    async def test_changed_payload_foreign_command_and_sanitized_failure(self):
        registry = ContextCommands(lambda: "acme.ui")
        calls = []
        async def handler(ctx):
            calls.append(ctx)
            raise RuntimeError("/private/path stack")
        registry.register("acme.ui.run", {}, handler)
        result = await registry.invoke(invocation())
        self.assertEqual(result, {"ok": False, "error": {
            "code": "PLUGIN_E_COMMAND_FAILED", "message": "Command failed."}})
        self.assertEqual(await registry.invoke(invocation()), result)
        self.assertEqual(len(calls), 1)
        changed = copy.deepcopy(invocation())
        changed["context"]["locale"] = "zh-TW"
        with self.assertRaises(SchemaError):
            await registry.invoke(changed)
        changed["command"] = "foreign.ui.run"
        with self.assertRaises(SchemaError):
            await registry.invoke(changed)

    async def test_cancel_caches_failure_without_restarting(self):
        registry = ContextCommands(lambda: "acme.ui")
        entered = asyncio.Event()
        calls = []
        async def handler(ctx):
            calls.append(ctx)
            entered.set()
            await asyncio.Event().wait()
        registry.register("acme.ui.run", {}, handler)
        task = asyncio.create_task(registry.invoke(invocation()))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)
        result = await registry.invoke(invocation())
        self.assertEqual(result["error"]["code"], "PLUGIN_E_CANCELLED")
        self.assertEqual(len(calls), 1)
