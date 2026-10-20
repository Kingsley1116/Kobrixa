import copy
import json
import unittest
from pathlib import Path
from kobrixa._ui import Ui, validate_resource, validate_invocation
from kobrixa._schema import SchemaError

FIXTURES = Path(__file__).resolve().parents[3] / "packages/plugin-protocol/test-fixtures/declarative-ui-v1"

class UiResourceTests(unittest.TestCase):
    def test_shared_positive_negative_maximum(self):
        for name in ("valid", "invalid", "maximum"):
            document = json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))
            self.assertEqual(set(document), {"formatVersion", "family", "cases"})
            self.assertEqual(document["formatVersion"], 1)
            self.assertEqual(document["family"], "declarative-ui-v1")
            for record in document["cases"]:
                self.assertEqual(record["schema"], "ui-resource-case")
                self.assertEqual(record["phase"], "resource")
                case = record["input"]
                self.assertEqual(len(case["raw"].encode("utf-8")), case["rawBytes"])
                self.assertEqual(json.loads(case["raw"]), case["resource"])
                with self.subTest(case=record["id"]):
                    context = {"pluginId": "acme.ui", "commands": case["commands"],
                               "panels": [{"id": value} for value in case["panels"]]}
                    if record["valid"]:
                        validate_resource(case["resource"], context, case["rawBytes"], case["version"])
                    else:
                        with self.assertRaises(SchemaError) as caught:
                            validate_resource(case["resource"], context, case["rawBytes"], case["version"])
                        self.assertEqual(caught.exception.business_code, record["expected"]["businessCode"])
                        self.assertEqual(caught.exception.reason, record["expected"]["reason"])

    def test_inline_semantic_reasons(self):
        leaf = {"op": "eq", "left": {"scope": "data", "key": "flag"}, "right": True}
        cases = [
            ("reference", {**leaf, "right": 1}),
            ("limit", {"op": "all", "items": [{"op": "all", "items": [leaf] * 8}] * 4}),
        ]
        for reason, condition in cases:
            resource = {"kind": "status", "tone": "neutral", "text": {"text": {"en": "Status"}},
                        "data": {"flag": {"schema": {"type": "boolean", "nullable": False}, "initial": True}},
                        "visibleWhen": condition}
            with self.subTest(reason=reason), self.assertRaises(SchemaError) as caught:
                validate_resource(resource, {"pluginId": "acme.ui", "commands": [], "panels": []}, len(json.dumps(resource).encode()))
            self.assertEqual(caught.exception.reason, reason)
            self.assertEqual(caught.exception.business_code, "PLUGIN_E_UI_RESOURCE")

    def test_huge_integer_is_rejected_without_overflow(self):
        from kobrixa._ui import number, safe_integer, valid_spec, accepts
        huge = 10 ** 400
        self.assertTrue(number(huge))
        self.assertFalse(safe_integer(huge))
        spec = {"type": "number", "min": 0, "max": huge, "integer": True, "nullable": False}
        self.assertFalse(valid_spec(spec))
        self.assertFalse(accepts(spec, huge))
        resource = {"kind": "status", "tone": "neutral", "text": {"text": {"en": "Status"}},
                    "data": {"count": {"schema": spec, "initial": 0}}}
        with self.assertRaises(SchemaError) as caught:
            validate_resource(resource, {"pluginId": "acme.ui", "commands": [], "panels": []}, 1000)
        self.assertEqual(caught.exception.reason, "schema")

    def test_context_spoof_and_unicode(self):
        value = {"version": 1, "invocationId": "00000000-0000-4000-8000-000000000001",
                 "command": "acme.ui.run", "arguments": {}, "context": {
                     "contextRef": None, "origin": "management", "locale": "en",
                     "trigger": {"kind": "activate"}}}
        validate_invocation(value)
        invalid = copy.deepcopy(value)
        invalid["context"]["role"] = "holder"
        with self.assertRaises(SchemaError):
            validate_invocation(invalid)

class UiClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_ready_and_common_unsubscribe(self):
        calls = []
        class Events:
            def begin(self):
                return lambda: None
            def adopt(self, **kwargs):
                calls.append(("adopt", kwargs["subscription_id"]))
            def forget(self, subscription_id):
                calls.append(("forget", subscription_id))
        async def request(method, params):
            calls.append((method, params))
            return {"ok": True, "value": {"removed": False}}
        ui = Ui(request, Events())
        with self.assertRaises(RuntimeError):
            await ui.instances()
        self.assertEqual(calls, [])
        ui.mark_ready()
        result = await ui.unsubscribe("00000000-0000-4000-8000-000000000001")
        self.assertFalse(result["value"]["removed"])
        self.assertEqual(calls[0][0], "events/unsubscribe")
