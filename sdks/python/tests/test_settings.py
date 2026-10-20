import json
import pathlib
import unittest
from kobrixa._settings import Settings, validate_resource, validate_values, check_version, wire_bytes
ROOT = pathlib.Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "packages/plugin-protocol/test-fixtures/settings-storage-v1"

class SettingsValidationTests(unittest.TestCase):
    def test_shared_resources(self):
        for case in json.loads((FIXTURES / "valid.json").read_text())["cases"]:
            if case["schema"] != "settingsResourceV1": continue
            resource = case["input"]
            self.assertEqual(validate_resource(resource, wire_bytes(resource)), resource)
        for case in json.loads((FIXTURES / "invalid.json").read_text())["cases"]:
            if case["schema"] != "settingsResourceV1": continue
            resource = case["input"]
            with self.assertRaises(ValueError):
                validate_resource(resource, wire_bytes(resource))

    def test_bytes_scalars_and_versions(self):
        field = {"key": "a.b", "label": {"en": "A"}, "type": "string", "default": "", "minLength": 0, "maxLength": 4000, "maxBytes": 4096}
        resource = {"schemaVersion": 1, "title": {"en": "T"}, "fields": [field]}
        validate_resource(resource, 65536)
        with self.assertRaises(ValueError): validate_resource(resource, 65537)
        validate_values(resource, [{"key": "a.b", "value": "😀" * 1024}], True)
        for value in ["😀" * 1025, "\ud800", True, float("nan")]:
            with self.assertRaises(ValueError): validate_values(resource, [{"key": "a.b", "value": value}], True)
        for count in [128, 129]:
            many = dict(resource, fields=[dict(field, key="a" + str(i)) for i in range(count)])
            if count == 128: validate_resource(many, wire_bytes(many))
            else:
                with self.assertRaises(ValueError): validate_resource(many, wire_bytes(many))
        for stored, declared, old, new in [(2, 1, "a", "a"), (1, 2, "a", "a"), (1, 1, "a", "b")]:
            with self.assertRaises(ValueError): check_version(stored, declared, old, new)
        self.assertEqual(wire_bytes("😀"), 6)
        self.assertEqual(wire_bytes("\n"), 4)

class SettingsClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_business_result_is_not_exception_or_retry(self):
        calls = []
        error = {"ok": False, "error": {"code": "PLUGIN_E_SETTINGS_CONFLICT", "message": "Conflict"}}
        async def request(method, params):
            calls.append((method, params))
            return error
        def validate(method, side, value):
            self.assertEqual(method, "settings/update")
            self.assertIn(side, ("params", "result"))
        client = Settings(request, validate)
        params = {"schemaVersion": 1, "expectedRevision": None, "changes": [{"key": "a", "value": True}]}
        self.assertIs(await client.update(params), error)
        self.assertEqual(calls, [("settings/update", params)])
        self.assertFalse(hasattr(client, "unwatch"))
