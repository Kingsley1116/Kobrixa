import asyncio
import copy
import unittest

from kobrixa._ui_data import UiData, validate_read
from kobrixa._ui_v2_data import UiDataValidationError


ID = "00000000-0000-4000-8000-000000000001"
BINDING = {"contributionId": "test.lab.panel", "panelInstance": ID, "kind": "panel",
           "uiResourceGeneration": 1, "generation": 1, "hostEpoch": ID, "processEpoch": ID}
BASE = {"binding": BINDING, "dataset": "code"}
METADATA = {"revision": 1, "presentation": 1, "byteLength": 20, "sha256": "a" * 64}


class UiDataClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_readiness_all_methods_timeout_and_result_copy(self):
        calls = []
        result = {"ok": True, "value": {"datasets": []}}

        async def request(method, params, timeout):
            calls.append((method, params, timeout))
            return result

        client = UiData(request)
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            await client.snapshot(BINDING)
        self.assertEqual(calls, [])
        client.mark_ready()
        # Structural request/result validation belongs to the supplied RPC port;
        # these responses are valid method results, not a schema bypass fixture.
        result = {"ok": True, "value": {"transfer": ID, "nextOffset": 0, "remainingMs": 5000}}
        await client.begin({**BASE, "baseRevision": 0, "presentation": 1, "header": {"kind": "code"},
                            "entryCount": 0, "byteLength": 20, "sha256": METADATA["sha256"]})
        result = {"ok": True, "value": {"nextOffset": 1, "remainingMs": 5000}}
        await client.chunk({**BASE, "transfer": ID, "offset": 0, "chunk": {"kind": "code", "entries": ["x"]}})
        result = {"ok": True, "value": METADATA}
        returned = await client.commit({**BASE, "transfer": ID})
        returned["value"]["revision"] = 99
        self.assertEqual(result["value"]["revision"], 1)
        result = {"ok": True, "value": {"aborted": False}}
        await client.abort({**BASE, "transfer": ID})
        result = {"ok": True, "value": {**METADATA, "header": {"kind": "code"},
                  "chunk": {"kind": "code", "entries": []}, "nextOffset": 0, "done": True}}
        await client.read({**BASE, "revision": 1, "offset": 0, "limit": 10})
        result = {"ok": True, "value": {"datasets": []}}
        await client.snapshot(BINDING)
        self.assertEqual([c[0] for c in calls], ["ui/dataBegin", "ui/dataChunk", "ui/dataCommit",
                                                "ui/dataAbort", "ui/dataRead", "ui/dataSnapshot"])
        self.assertEqual([c[2] for c in calls], [5] * 6)
        client.retire()
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            await client.snapshot(BINDING)

    async def test_retire_and_re_ready_rejects_old_session_reply(self):
        started, finish = asyncio.Event(), asyncio.Event()

        async def request(method, params, timeout):
            started.set()
            await finish.wait()
            return {"ok": True, "value": {"datasets": []}}

        client = UiData(request)
        client.mark_ready()
        task = asyncio.create_task(client.snapshot(BINDING))
        await started.wait()
        client.retire()
        client.mark_ready()
        finish.set()
        with self.assertRaisesRegex(RuntimeError, "retired"):
            await task

    async def test_task_cancel_timeout_and_business_failure_never_retry_or_abort(self):
        started = asyncio.Event()
        calls, cancellations = [], []

        async def request(method, params, timeout):
            calls.append(method)
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancellations.append(method)
                raise

        client = UiData(request)
        client.mark_ready()
        task = asyncio.create_task(client.commit({**BASE, "transfer": ID}))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(calls, ["ui/dataCommit"])
        self.assertEqual(cancellations, calls)

        async def timeout(method, params, timeout):
            calls.append(method)
            raise asyncio.TimeoutError()

        client = UiData(timeout)
        client.mark_ready()
        with self.assertRaises(asyncio.TimeoutError):
            await client.commit({**BASE, "transfer": ID})
        self.assertEqual(calls, ["ui/dataCommit"] * 2)

        denied = {"ok": False, "error": {"code": "PLUGIN_E_RESOURCE_LIMIT", "message": "Rejected",
                  "detail": {"kind": "ui-data", "reason": "quota"}}}

        async def failure(method, params, timeout):
            calls.append(method)
            return denied

        client = UiData(failure)
        client.mark_ready()
        self.assertEqual(await client.commit({**BASE, "transfer": ID}), denied)
        self.assertEqual(calls, ["ui/dataCommit"] * 3)

    async def test_snapshot_duplicates_and_page_reply_semantics(self):
        result = {"ok": True, "value": {"datasets": [{**METADATA, "dataset": "code"}] * 2}}

        async def request(method, params, timeout):
            return result

        client = UiData(request)
        client.mark_ready()
        with self.assertRaises(UiDataValidationError):
            await client.snapshot(BINDING)
        request_params = {**BASE, "revision": 1, "offset": 0, "limit": 1}
        value = {**METADATA, "header": {"kind": "code"}, "chunk": {"kind": "code", "entries": ["x"]},
                 "nextOffset": 1, "done": True}
        for mutate in (
            lambda v: v.update(revision=2),
            lambda v: v.update(nextOffset=2),
            lambda v: v.update(chunk={"kind": "code", "entries": ["x", "y"]}),
            lambda v: v.update(chunk={"kind": "code", "entries": []}, nextOffset=0, done=False),
            lambda v: v.update(header={"kind": "table"}),
        ):
            bad = copy.deepcopy(value)
            mutate(bad)
            result = {"ok": True, "value": bad}
            with self.assertRaises(UiDataValidationError):
                await client.read(request_params)

    async def test_input_snapshot_is_held_during_await(self):
        started, finish = asyncio.Event(), asyncio.Event()
        captured = []

        async def request(method, params, timeout):
            captured.append(params)
            started.set()
            await finish.wait()
            return {"ok": True, "value": {**METADATA, "header": {"kind": "code"},
                    "chunk": {"kind": "code", "entries": ["x"]}, "nextOffset": 1, "done": True}}

        client = UiData(request)
        client.mark_ready()
        params = {**BASE, "revision": 1, "offset": 0, "limit": 1}
        task = asyncio.create_task(client.read(params))
        await started.wait()
        params["offset"] = 999
        finish.set()
        self.assertTrue((await task)["ok"])
        self.assertEqual(captured[0]["offset"], 0)

    async def test_page_wrapper_bytes_count_and_invalid_chunk_never_dispatch(self):
        calls = []

        async def request(method, params, timeout):
            calls.append(method)
            return {"ok": True, "value": {"datasets": []}}

        client = UiData(request)
        client.mark_ready()
        with self.assertRaises(UiDataValidationError):
            await client.chunk({**BASE, "transfer": ID, "offset": 0,
                                "chunk": {"kind": "code", "entries": ["\0"]}})
        self.assertEqual(calls, [])
        entries = ["x" * 1024] * 47 + ["x" * 853]
        value = {**METADATA, "header": {"kind": "code"}, "chunk": {"kind": "code", "entries": entries},
                 "nextOffset": 48, "done": True}
        with self.assertRaises(UiDataValidationError) as error:
            validate_read(value, {"revision": 1, "offset": 0, "limit": 256})
        self.assertEqual(error.exception.reason, "quota")
