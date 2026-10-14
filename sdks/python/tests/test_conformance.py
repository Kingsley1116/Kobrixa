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
