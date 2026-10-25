import json
import unittest
from types import MappingProxyType
from unittest.mock import patch, MagicMock
from concurrent.futures import ThreadPoolExecutor
import kobrixa._schema as schema
from kobrixa._schema import Validator, SchemaError


class SchemaCacheTests(unittest.TestCase):
    def test_bundled_instances_share_an_immutable_schema(self):
        first = Validator.bundled()
        second = Validator.bundled()
        self.assertIsNot(first, second)
        self.assertIs(first._definitions, second._definitions)
        name = "initialize.params"
        with self.assertRaises(TypeError):
            first._definitions[name]["properties"]["apiVersion"]["type"] = "number"
        with self.assertRaises(TypeError):
            first._definitions[name]["required"][0] = "forged"
        with self.assertRaises(TypeError):
            first._definitions[name] = True
        with self.assertRaises(SchemaError):
            second.validate(name, {"apiVersion": 42})

    def test_warm_clients_do_not_read_or_parse_the_bundle_again(self):
        Validator.bundled()
        with patch("kobrixa._schema.resources.files", side_effect=AssertionError("read again")), patch("kobrixa._schema.json.loads", side_effect=AssertionError("parse again")):
            clients = [Validator.bundled() for _ in range(20)]
        self.assertEqual(len({id(client._definitions) for client in clients}), 1)

    def test_concurrent_first_clients_read_one_bundle(self):
        fake = MagicMock()
        fake.joinpath.return_value.read_text.return_value = '{"$defs":{"number":{"type":"number"}}}'
        schema._bundled_schema.cache_clear()
        try:
            with patch("kobrixa._schema.resources.files", return_value=fake):
                with ThreadPoolExecutor(max_workers=8) as pool:
                    clients = list(pool.map(lambda _: Validator.bundled(), range(24)))
            fake.joinpath.return_value.read_text.assert_called_once_with("utf-8")
            self.assertEqual(len({id(client._definitions) for client in clients}), 1)
            for client in clients:
                client.validate("number", 1)
        finally:
            schema._bundled_schema.cache_clear()

    def test_custom_input_cannot_mutate_a_validator_or_the_bundle(self):
        document = {"$defs": {"value": {"type": ["array", "null"], "items": {"type": "number"}, "const": [1, 2]}}}
        validator = Validator(document)
        document["$defs"]["value"]["items"]["type"] = "string"
        document["$defs"]["value"]["const"][0] = 9
        validator.validate("value", [1, 2])
        with self.assertRaises(SchemaError): validator.validate("value", [1, "2"])
        with self.assertRaises(SchemaError): validator.validate("value", [True, 2])
        self.assertFalse(Validator.bundled().has("value"))

    def test_nested_mapping_proxies_do_not_retain_caller_backing_storage(self):
        rule = {"type": "number"}
        constant = {"rows": [[True, 1]]}
        definitions = {
            "value": {"type": "object", "additionalProperties": MappingProxyType(rule)},
            "constant": {"const": MappingProxyType(constant)},
            "choice": {"anyOf": (MappingProxyType(rule),)},
        }
        validator = Validator({"$defs": MappingProxyType(definitions)})
        rule["type"] = "string"
        constant["rows"][0][0] = 1
        definitions["value"] = True
        validator.validate("value", {"x": 2})
        validator.validate("constant", {"rows": [[True, 1]]})
        validator.validate("choice", 2)
        with self.assertRaises(SchemaError): validator.validate("value", {"x": "bad"})
        with self.assertRaises(SchemaError): validator.validate("constant", {"rows": [[1, 1]]})
        with self.assertRaises(SchemaError): validator.validate("choice", "bad")
        with self.assertRaises(TypeError):
            validator._definitions["value"]["additionalProperties"]["type"] = "string"

    def test_failed_bundle_reads_and_parses_are_retried(self):
        for failure in (OSError("read failed"), "{"):
            with self.subTest(failure=repr(failure)):
                fake = MagicMock()
                fake.joinpath.return_value.read_text.side_effect = [
                    failure, '{"$defs":{"number":{"type":"number"}}}',
                ]
                schema._bundled_schema.cache_clear()
                try:
                    with patch("kobrixa._schema.resources.files", return_value=fake):
                        with self.assertRaises((OSError, json.JSONDecodeError)):
                            Validator.bundled()
                        recovered = Validator.bundled()
                        warm = Validator.bundled()
                    self.assertEqual(fake.joinpath.return_value.read_text.call_count, 2)
                    self.assertIs(recovered._definitions, warm._definitions)
                    recovered.validate("number", 2)
                    with self.assertRaises(SchemaError): recovered.validate("number", True)
                finally:
                    schema._bundled_schema.cache_clear()

    def test_frozen_schema_additional_properties_and_json_constants(self):
        validator = Validator(json.loads('{"$defs":{"value":{"type":"object","additionalProperties":{"type":"array","items":{"type":"number"}}},"constant":{"const":{"rows":[true,1,null]}},"choice":{"enum":[[1,2],[3,4]]}}}'))
        validator.validate("value", {"x": [1, 2]})
        with self.assertRaises(SchemaError): validator.validate("value", {"x": ["bad"]})
        validator.validate("constant", {"rows": [True, 1, None]})
        with self.assertRaises(SchemaError): validator.validate("constant", {"rows": [1, True, None]})
        validator.validate("choice", [3, 4])
        with self.assertRaises(SchemaError): validator.validate("choice", [1, 3])


if __name__ == "__main__": unittest.main()
