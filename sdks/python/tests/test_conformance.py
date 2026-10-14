import json
import unittest
from pathlib import Path
from kobrixa._schema import SUPPORTED_KEYWORDS, SchemaError, Validator

PROTOCOL = Path(__file__).resolve().parents[3] / "packages" / "plugin-protocol"


def expand(value):
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        if isinstance(value.get("$repeat"), str) and isinstance(value.get("count"), int):
            return value["$repeat"] * value["count"]
        return {key: expand(item) for key, item in value.items()}
    return value


class ConformanceTest(unittest.TestCase):
    def test_integer_validation_does_not_convert_python_ints_to_float(self):
        validator = Validator({"$defs": {"integer": {"type": "integer"}}})
        for value in (0, 10 ** 399, -(10 ** 399), 1.0, -1.0):
            with self.subTest(value=value):
                validator.validate("integer", value)
        for value in (True, False, 0.5, float("nan"), float("inf"), -float("inf"), "1"):
            with self.subTest(value=value), self.assertRaises(SchemaError):
                validator.validate("integer", value)

    def test_oversized_request_ids_raise_schema_errors(self):
        validator = Validator.bundled()
        for value in (10 ** 399, -(10 ** 399)):
            with self.subTest(value=value), self.assertRaises(SchemaError):
                validator.validate("message", {"jsonrpc": "2.0", "id": value,
                                               "method": "shutdown", "params": {}})

    def test_keywords_match_the_shared_allowlist(self):
        allowed = json.loads((PROTOCOL / "schema" / "keywords.json").read_text("utf-8"))
        self.assertEqual(SUPPORTED_KEYWORDS, frozenset(allowed))

    def test_shared_cases(self):
        validator = Validator.bundled()
        cases = json.loads((PROTOCOL / "conformance" / "cases.json").read_text("utf-8"))
        for case in cases:
            with self.subTest(case["name"]):
                try:
                    validator.validate(case["definition"], expand(case["value"]))
                    accepted = True
                except SchemaError:
                    accepted = False
                self.assertEqual(accepted, case["valid"])
