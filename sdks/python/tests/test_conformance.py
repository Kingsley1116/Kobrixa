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
    def test_language_services_are_strict_and_api_is_1_7(self):
        from kobrixa._plugin import API_VERSION
        self.assertEqual(API_VERSION, "1.7.0")
        validator = Validator.bundled()
        value = {"id": "test.language", "version": "1.0.0", "apiVersion": "^1.3.0",
                 "runtime": {"kind": "builtin"}, "contributes": {"languageServices": [
                     {"language": "case", "extensions": ["csx"], "capabilities": ["analysis"]}]}}
        validator.validate("manifest", value)
        value["contributes"]["languageServices"][0]["entry"] = "service.py"
        with self.assertRaises(SchemaError):
            validator.validate("manifest", value)

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

    def test_persistence_fixtures_through_bundled_schema_and_domain_semantics(self):
        validator = Validator.bundled()
        for family in ("valid", "invalid", "maximum"):
            document = json.loads((PROTOCOL / "test-fixtures" / "settings-storage-v1" / f"{family}.json").read_text("utf-8"))
            self.assertEqual(set(document), {"formatVersion", "family", "cases"})
            self.assertIs(type(document["formatVersion"]), int)
            self.assertEqual(document["formatVersion"], 1)
            self.assertEqual(document["family"], "settings-storage-v1")
            self.assertIs(type(document["cases"]), list)
            self.assertTrue(document["cases"])
            ids = set()
            for case in document["cases"]:
                self.assertEqual(set(case), {"id", "schema", "phase", "input", "valid", "expected"})
                self.assertIs(type(case["id"]), str)
                self.assertTrue(case["id"])
                self.assertNotIn(case["id"], ids)
                ids.add(case["id"])
                self.assertIn(case["phase"], ("params", "result", "resource", "event"))
                self.assertIs(type(case["valid"]), bool)
                expected = case["expected"]
                self.assertEqual(set(expected), {"numericCode", "businessCode", "reason", "permission", "lifetime", "persistedSha256"})
                self.assertTrue(expected["numericCode"] is None or type(expected["numericCode"]) is int)
                for field in ("businessCode", "reason", "permission", "lifetime", "persistedSha256"):
                    self.assertTrue(expected[field] is None or type(expected[field]) is str)
                if expected["persistedSha256"] is not None:
                    self.assertRegex(expected["persistedSha256"], r"^[0-9a-f]{64}$")
                if case["valid"]:
                    self.assertTrue(all(v is None for v in expected.values()))
                schema = case["schema"]
                definition = {"settingsResourceV1": "settings-resource-v1", "chunk": "storage/writeChunk.params"}.get(schema, f"{schema}.{case['phase']}")
                self.assertTrue(validator.has(definition), definition)
                with self.subTest(family=family, id=case["id"]):
                    value = case["input"]
                    try:
                        if schema == "chunk":
                            validator.validate(definition, {"write": "11111111-1111-4111-8111-111111111111", "offset": 0, "data": value})
                        else:
                            validator.validate(definition, value)
                        accepted = True
                    except (ValueError, SchemaError):
                        accepted = False
                    self.assertEqual(accepted, case["valid"])

    def test_persistence_wire_semantics_are_applied_by_the_public_validator(self):
        validator = Validator.bundled()
        handle = "11111111-1111-4111-8111-111111111111"
        for text in ("😀" * 16385, "\ud800", "\0"):
            with self.subTest(copy=len(text)), self.assertRaises(SchemaError):
                validator.validate("ui/copyText.params", {"actionRef": handle, "text": text})
        for data in ("YQ", "YR==", "YQ==\n", "A" * 349529):
            with self.subTest(chunk=len(data)), self.assertRaises(SchemaError):
                validator.validate("storage/writeChunk.params", {"write": handle, "offset": 0, "data": data})
        for code, detail in (
            ("PLUGIN_E_SETTINGS_CONFLICT", {"kind": "persistence", "reason": "disk-full"}),
            ("PLUGIN_E_SETTINGS_SCHEMA", {"kind": "permission", "reason": "permission"}),
            ("PLUGIN_E_TIMEOUT", {"kind": "persistence", "reason": "io"}),
        ):
            with self.subTest(code=code), self.assertRaises(SchemaError):
                validator.validate("settings/read.result", {"ok": False, "error": {"code": code, "message": "Rejected", "detail": detail}})

    def test_persistence_key_and_record_result_semantics(self):
        validator = Validator.bundled()
        for keys in (["fixture.enabled", "fixture.enabled"], ["constructor"]):
            with self.subTest(keys=keys), self.assertRaises(SchemaError):
                validator.validate("settings/reset.params", {"schemaVersion": 1, "expectedRevision": None, "keys": keys})
        record = {"id": "11111111-1111-4111-8111-111111111111", "revision": "r_" + "1" * 32,
            "kind": "test.fixture", "schemaVersion": 1, "label": "x" * 161,
            "mediaType": "text/plain", "byteLength": 0, "sha256": "0" * 64,
            "createdAt": 0, "updatedAt": 0, "checkpoint": "none", "interrupted": False}
        with self.assertRaises(SchemaError):
            validator.validate("storage/stat.result", {"ok": True, "value": {"record": record}})
