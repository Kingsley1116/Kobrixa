import hashlib
import json
import struct
import unittest
from pathlib import Path
from kobrixa._ui_v2_canonical import canonical_json_bytes

FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures/declarative-ui-v2/data"


class CanonicalUiDataTests(unittest.TestCase):
    def test_shared_dataset_golden_bytes_and_hashes(self):
        for case in json.loads((FIXTURES / "canonical-golden.json").read_text(encoding="utf-8")):
            with self.subTest(case=case["name"]):
                data = json.loads(case["canonical"])
                if case["name"] == "numbers":
                    data[1][0]["cells"][0] = -0.0
                actual = canonical_json_bytes(data)
                self.assertEqual(actual, case["canonical"].encode("utf-8"))
                self.assertEqual(len(actual), case["byteLength"])
                self.assertEqual(hashlib.sha256(actual).hexdigest(), case["sha256"])

    def test_binary64_matches_independent_javascript_vectors(self):
        cases = json.loads((FIXTURES / "binary64-golden.json").read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 990)
        for case in cases:
            with self.subTest(bits=case["bits"]):
                value = struct.unpack(">d", bytes.fromhex(case["bits"]))[0]
                self.assertEqual(canonical_json_bytes(value), case["json"].encode())

    def test_number_layout_boundaries_and_booleans(self):
        for value, expected in [(0.0, "0"), (-0.0, "0"), (1.0, "1"), (1e-6, "0.000001"),
                                (1e-7, "1e-7"), (1e20, "100000000000000000000"),
                                (1e21, "1e+21"), (True, "true"), (False, "false")]:
            self.assertEqual(canonical_json_bytes(value), expected.encode())

    def test_rejects_lossy_non_json_and_unsafe_values(self):
        cycle = []; cycle.append(cycle)
        for value in [float("inf"), float("nan"), 2**53 + 1, 10**400, "\ud800", cycle,
                      {"constructor": 1}, {1: "x"}, {"0": "x"}, (1,), object()]:
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                canonical_json_bytes(value)
