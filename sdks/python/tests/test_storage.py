import base64
import unittest
from kobrixa._storage import Storage, canonical_base64_length, validate_record_write, drain_submission

class StorageValidationTests(unittest.TestCase):
    def test_chunk_and_record_boundaries(self):
        for text in ["Zh==", "Zg", "Zg===", "Zg==\n", "_w==", "Zm9=", ""]:
            with self.assertRaises(ValueError): canonical_base64_length(text)
        self.assertEqual(canonical_base64_length("Zg=="), 1)
        self.assertEqual(canonical_base64_length("", True), 0)
        self.assertEqual(canonical_base64_length(base64.b64encode(bytes(262144)).decode()), 262144)
        with self.assertRaises(ValueError): canonical_base64_length(base64.b64encode(bytes(262145)).decode())
        base = {"target": {"mode": "create"}, "kind": "lab.samples", "schemaVersion": 1, "label": "Lab", "mediaType": "application/octet-stream", "byteLength": 0, "sha256": "0" * 64}
        for n in [0, 8388608]: validate_record_write(dict(base, byteLength=n))
        for n in [8388609, True, "0", float("nan"), float("inf"), -1, 0.5, 9007199254740992]:
            with self.assertRaises(ValueError): validate_record_write(dict(base, byteLength=n))
        with self.assertRaises(ValueError): drain_submission({"status": "saved", "writes": []})
        self.assertEqual(drain_submission({"status": "submitted", "writes": []})["status"], "submitted")

class StorageClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_lost_commit_is_not_replayed(self):
        calls = []
        async def request(method, params):
            calls.append(method)
            raise TimeoutError("lost reply")
        client = Storage(request, lambda *args: None)
        with self.assertRaises(TimeoutError): await client.commit_write({"write": "00000000-0000-4000-8000-000000000001"})
        self.assertEqual(calls, ["storage/commitWrite"])
