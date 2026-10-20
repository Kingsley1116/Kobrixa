import unittest
from kobrixa._persistence_actions import PersistenceActions, validate_copy

class ActionTests(unittest.IsolatedAsyncioTestCase):
    async def test_plain_text_and_no_replay(self):
        h = "00000000-0000-4000-8000-000000000001"
        validate_copy({"actionRef": h, "text": "😀" * 16384})
        for text in ["😀" * 16385, "a" * 16385, "\0", "\udfff"]:
            with self.assertRaises(ValueError): validate_copy({"actionRef": h, "text": text})
        count = 0
        async def request(method, params):
            nonlocal count
            count += 1
            raise TimeoutError("lost reply")
        with self.assertRaises(TimeoutError): await PersistenceActions(request, lambda *args: None).copy_text({"actionRef": h, "text": "x"})
        self.assertEqual(count, 1)
