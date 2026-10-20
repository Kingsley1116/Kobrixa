import copy
import json
import unittest
from importlib import resources
from pathlib import Path
from kobrixa._plugin import API_VERSION
from kobrixa._schema import SchemaError, Validator

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "plugin-protocol" / "test-fixtures" / "static-languages"


class StaticLanguagesTest(unittest.TestCase):
    def setUp(self):
        self.validator = Validator.bundled()
        self.manifest = json.loads((FIXTURES / "toy" / "kobrixa-plugin.json").read_text("utf-8"))

    def test_api_and_schema_identity(self):
        self.assertEqual(API_VERSION, "1.5.0")
        document = json.loads(resources.files("kobrixa").joinpath("plugin-protocol.schema.json").read_text("utf-8"))
        self.assertEqual(document["$id"], "https://kobrixa.com/schemas/plugin-protocol/1.5.0.json")
        for name in ("static-language-tokenizer-v1", "static-language-configuration-v1"):
            self.assertTrue(self.validator.has(name))
            self.assertIs(document["$defs"][name]["additionalProperties"], False)

    def test_frozen_resources_and_static_manifest(self):
        self.validator.validate("manifest", self.manifest)
        for folder in ("minimal", "basic-plus", "toy/language"):
            for kind in ("tokenizer", "configuration"):
                with self.subTest(folder=folder, kind=kind):
                    data = json.loads((FIXTURES / folder / f"{kind}.json").read_text("utf-8"))
                    self.validator.validate(f"static-language-{kind}-v1", data)
        for runtime in ({"kind": "static", "entry": "main.py"}, {"kind": "static", "future": True}):
            value = copy.deepcopy(self.manifest)
            value["runtime"] = runtime
            with self.assertRaises(SchemaError):
                self.validator.validate("manifest", value)

    def test_alias_and_pattern_lengths_use_decoded_code_points(self):
        for length in (80, 81):
            value = copy.deepcopy(self.manifest)
            value["contributes"]["languages"][0]["aliases"] = ["😀" * length]
            if length == 80:
                self.validator.validate("manifest", value)
            else:
                with self.assertRaises(SchemaError):
                    self.validator.validate("manifest", value)
        for length in (2048, 2049):
            value = {"wordPattern": {"pattern": "😀" * length, "flags": ""}}
            if length == 2048:
                self.validator.validate("static-language-configuration-v1", value)
            else:
                with self.assertRaises(SchemaError):
                    self.validator.validate("static-language-configuration-v1", value)

    def test_ecmascript_pattern_remains_data_for_python(self):
        # Structural acceptance is not ECMAScript semantic acceptance. The host
        # rejects backreferences/zero-width tokenizer patterns after parsing.
        for source in (r"(?<word>a)\k<word>", "(", "^", r"\$S1", "@name"):
            self.validator.validate("static-language-configuration-v1", {
                "wordPattern": {"pattern": source, "flags": "i"}})
        for source in ("\t", "\u0085"):
            with self.assertRaises(SchemaError):
                self.validator.validate("static-language-configuration-v1", {
                    "wordPattern": {"pattern": source, "flags": ""}})
