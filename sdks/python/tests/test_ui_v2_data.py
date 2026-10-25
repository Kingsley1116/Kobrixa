import copy
import hashlib
import json
import unittest
from pathlib import Path

from kobrixa._ui_v2_data import (
    UiDataValidationError, validate_declaration, validate_header, validate_chunk,
    validate_dataset, canonical_dataset_bytes, canonical_chunk_bytes, validate_panel,
)

FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures/declarative-ui-v2/data"


def chart():
    declaration = {"kind": "chart", "series": [{"id": "s", "label": {"en": "Series"}}]}
    header = {"kind": "chart", "timeDomain": [0, 1800000], "view": "full", "series": [{
        "id": "s", "unit": "deg", "range": [-100, 100],
        "extrema": [[0, -100], [500, 100]], "fullPointCount": 3600,
        "omittedPoints": 2800, "omittedRuns": 0,
    }]}
    entries = [[0, 0, i * 500, 100 if i % 2 else -100] for i in range(800)]
    return declaration, header, entries


class UiDataTests(unittest.TestCase):
    def test_shared_javascript_python_admission_cases(self):
        operations = {"declaration": validate_declaration, "header": validate_header,
                      "chunk": validate_chunk, "dataset": validate_dataset}
        for case in json.loads((FIXTURES / "semantic-cases.json").read_text()):
            with self.subTest(case=case["name"]):
                operation = operations[case["op"]]
                if case["valid"]:
                    operation(*case["args"])
                else:
                    with self.assertRaises(UiDataValidationError):
                        operation(*case["args"])

    def test_shared_typed_golden_bytes_and_hashes(self):
        for case in json.loads((FIXTURES / "canonical-golden.json").read_text()):
            header, entries = json.loads(case["canonical"])
            actual = canonical_dataset_bytes(header, entries)
            self.assertEqual(actual, case["canonical"].encode())
            self.assertEqual(len(actual), case["byteLength"])
            self.assertEqual(hashlib.sha256(actual).hexdigest(), case["sha256"])

    def test_rebuilds_key_order_without_mutating(self):
        _, header, entries = chart()
        reversed_header = dict(reversed(list(header.items())))
        reversed_header["series"] = [dict(reversed(list(header["series"][0].items())))]
        before = copy.deepcopy(reversed_header)
        self.assertEqual(canonical_dataset_bytes(header, entries),
                         canonical_dataset_bytes(reversed_header, entries))
        self.assertEqual(reversed_header, before)
        row = {"cells": ["臺😀"], "version": None, "key": "row"}
        self.assertEqual(canonical_dataset_bytes({"kind": "table"}, [row]),
                         '[{"kind":"table"},[{"key":"row","version":null,"cells":["臺😀"]}]]'.encode())

    def test_chart_maxima_order_gaps_extrema_and_counts(self):
        declaration, header, entries = chart()
        self.assertEqual(len(validate_dataset(declaration, header, entries)["entries"]), 800)
        bad = [
            (lambda h, e: e.__setitem__(500, [1, 0, 1000, 0])),
            (lambda h, e: e.__setitem__(500, [0, -1, 1000, 0])),
            (lambda h, e: e.__setitem__(500, [0, 0, 0, 0])),
            (lambda h, e: e.__setitem__(500, [0, 0, 250000, 101])),
            (lambda h, e: h["series"][0].__setitem__("omittedPoints", 2799)),
            (lambda h, e: h["series"][0].__setitem__("extrema", [[0, -100], [501, 100]])),
            (lambda h, e: h["series"][0].__setitem__("omittedRuns", 2801)),
            (lambda h, e: e.append([0, 0, 400000, 0])),
        ]
        for change in bad:
            h, e = copy.deepcopy(header), copy.deepcopy(entries)
            change(h, e)
            with self.subTest(change=bad.index(change)), self.assertRaises(UiDataValidationError):
                validate_dataset(declaration, h, e)
        header["series"][0].update(fullPointCount=3, omittedPoints=0)
        for last in ([0, 1, 0, -100], [0, 0, 500, 100]):
            validate_dataset(declaration, header, [[0, 0, 0, -100], [0, 0, 500, 100], last])

    def test_empty_chart_preserves_explicit_domain_and_declaration_order(self):
        declaration, header, _ = chart()
        header["series"][0].update(fullPointCount=0, omittedPoints=0, extrema=None)
        self.assertEqual(validate_dataset(declaration, header, [])["header"]["timeDomain"], [0, 1800000])
        for domain in ([1, 1000], [0, 999], [False, 1000], [0, float("inf")]):
            with self.subTest(domain=domain), self.assertRaises(UiDataValidationError):
                validate_header({**header, "timeDomain": domain})
        with self.assertRaises(UiDataValidationError):
            validate_header(header, {"kind": "chart", "series": [{"id": "other", "label": {"en": "Other"}}]})

    def test_rows_types_counts_keys_and_unicode(self):
        declaration = {"kind": "table", "columns": [{"id": "v", "label": {"en": "Value"}, "value": "number"}]}
        row = {"key": "r", "version": None, "cells": [1]}
        validate_dataset(declaration, {"kind": "table"}, [row])
        validate_dataset(declaration, {"kind": "table"}, [{**row, "cells": [None]}])
        for rows in ([row, row], [{**row, "cells": [True]}], [{**row, "cells": ["1"]}],
                     [{**row, "version": ""}], [{**row, "key": ""}],
                     [{**row, "key": str(i)} for i in range(51)]):
            with self.assertRaises(UiDataValidationError):
                validate_dataset(declaration, {"kind": "table"}, rows)
        validate_chunk({"kind": "table", "entries": [{**row, "cells": ["😀" * 200]}]})
        for cell in ("😀" * 201, "\0", "\ud800", float("nan"), 2**53 + 1):
            with self.assertRaises(UiDataValidationError):
                validate_chunk({"kind": "table", "entries": [{**row, "cells": [cell]}]})

    def test_code_and_exact_chunk_byte_bound(self):
        validate_dataset({"kind": "code"}, {"kind": "code"}, ["😀" * 1024] * 16)
        for entries in ([""], ["😀" * 1025], ["x" * 1024] * 16 + ["x"]):
            with self.assertRaises(UiDataValidationError):
                canonical_dataset_bytes({"kind": "code"}, entries)
        entries = ["x" * 1024] * 47 + ["x" * 853]
        self.assertEqual(len(canonical_chunk_bytes({"kind": "code", "entries": entries})), 49152)
        entries[-1] += "x"
        with self.assertRaises(UiDataValidationError):
            validate_chunk({"kind": "code", "entries": entries})
        with self.assertRaises(UiDataValidationError):
            validate_chunk({"kind": "code", "entries": ["\x01" * 1024] * 9})
        with self.assertRaises(UiDataValidationError):
            validate_chunk({"kind": "code", "entries": ["x"] * 257})

    def test_rejects_python_only_values_unknown_keys_and_unsafe_ids(self):
        class DictSubclass(dict):
            pass
        for header in ({"kind": "other"}, {"kind": "code", "extra": 1},
                       {"kind": "code", "constructor": {}}, DictSubclass(kind="code")):
            with self.assertRaises(UiDataValidationError):
                validate_header(header)
        for id_ in ("constructor", "prototype", "__proto__", "S", "s\n"):
            with self.assertRaises(UiDataValidationError):
                validate_declaration({"kind": "chart", "series": [{"id": id_, "label": {"en": "Series"}}]})
        for label in ({"en": "\t"}, {"en": "\ufeff"}, {"en": "x", "extra": "x"}):
            with self.assertRaises(UiDataValidationError):
                validate_declaration({"kind": "chart", "series": [{"id": "s", "label": label}]})
        # NEL is not ECMAScript trim whitespace, unlike Python str.strip().
        validate_declaration({"kind": "chart", "series": [{"id": "s", "label": {"en": "\u0085"}}]})

    def test_panel_aggregate_exact_boundary_and_code_count(self):
        declaration = {"kind": "table", "columns": [
            {"id": "c" + str(i), "label": {"en": "Column"}, "value": "string"} for i in range(8)]}
        rows = [{"key": "row-" + str(i), "version": "00000000-0000-4000-8000-000000000001",
                 "cells": ["臺" * 200] * 8} for i in range(50)]
        tables = [{"declaration": declaration, "header": {"kind": "table"}, "entries": rows}] * 2
        entries = ["臺" * 950] * 12
        size = sum(len(canonical_dataset_bytes(d["header"], d["entries"])) for d in tables)
        size += len(canonical_dataset_bytes({"kind": "code"}, entries))
        entries[0] += "x" * (524288 - size)
        datasets = tables + [{"declaration": {"kind": "code"}, "header": {"kind": "code"}, "entries": entries}]
        self.assertEqual(validate_panel(datasets)["byteLength"], 524288)
        entries[0] += "x"
        with self.assertRaises(UiDataValidationError):
            validate_panel(datasets)
        with self.assertRaises(UiDataValidationError):
            validate_panel([{"declaration": {"kind": "code"}, "header": {"kind": "code"}, "entries": []}] * 2)
