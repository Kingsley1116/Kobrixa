"""Typed UI v2 dataset validation and canonical bytes, before RPC admission.

This local leaf mirrors the protocol's explicit dataset validators. It does not
authorize a panel, reserve storage, validate a transfer digest or negotiate v2.
Objects are rebuilt in contract order; Python-only containers and lossy numbers
are rejected before the shared ECMAScript binary64 encoder is called.
"""
import math
import re

from ._ui_v2_canonical import canonical_json_bytes


class UiDataValidationError(ValueError):
    def __init__(self, reason="schema"):
        super().__init__(f"Invalid UI v2 data: {reason}.")
        self.reason = reason


def _require(condition, reason="schema"):
    if not condition:
        raise UiDataValidationError(reason)


def _object(value, required, optional=()):
    _require(type(value) is dict)
    _require(set(required) <= value.keys() <= set(required) | set(optional))
    return value


def _array(value, minimum=0, maximum=16384):
    _require(type(value) is list and minimum <= len(value) <= maximum)
    return value


def _number(value, minimum=-math.inf, maximum=math.inf):
    _require(type(value) in (int, float))
    try:
        binary = float(value)
    except OverflowError as error:
        raise UiDataValidationError() from error
    _require(math.isfinite(binary) and minimum <= binary <= maximum)
    _require(type(value) is not int or binary == value)
    return value


def _counter(value, maximum=9007199254740991):
    _number(value, 0, maximum)
    _require(int(value) == value)
    return value


def _text(value, maximum, minimum=0):
    _require(type(value) is str and minimum <= len(value) <= maximum)
    _require(all(ord(c) != 0 and not 0xD800 <= ord(c) <= 0xDFFF for c in value))
    return value


def _id(value):
    _require(type(value) is str and re.fullmatch(r"[a-z][a-z0-9-]{0,31}", value) is not None)
    _require(value not in ("constructor", "prototype", "__proto__"), "reference")
    return value


def _unique(values):
    _require(len(values) == len(set(values)), "reference")


def _bytes(value):
    try:
        return canonical_json_bytes(value)
    except ValueError as error:
        raise UiDataValidationError() from error


def _label(value):
    _object(value, ("en",), ("zh-TW",))
    # String.trim's ECMAScript set, not Python's broader str.strip set.
    whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
    result = {}
    for key in ("en", "zh-TW"):
        if key in value:
            text = _text(value[key], 200, 1)
            _require(bool(text.strip(whitespace)) and all(ord(c) >= 32 and ord(c) != 127 for c in text))
            result[key] = text
    return result


def validate_declaration(value):
    _require(type(value) is dict)
    kind = value.get("kind")
    _require(type(kind) is str and kind in ("chart", "table", "list", "code"))
    field = "series" if kind == "chart" else "columns"
    _object(value, ("kind",) if kind == "code" else ("kind", field))
    result = {"kind": kind}
    if kind == "code":
        return result
    items = _array(value[field], 1, {"chart": 2, "table": 8, "list": 3}[kind])
    fields = []
    for item in items:
        _object(item, ("id", "label") if kind == "chart" else ("id", "label", "value"))
        parsed = {"id": _id(item["id"]), "label": _label(item["label"])}
        if kind != "chart":
            _require(type(item["value"]) is str and item["value"] in ("string", "number", "boolean"))
            parsed["value"] = item["value"]
        fields.append(parsed)
    _unique([item["id"] for item in fields])
    result[field] = fields
    return result


def _pair(value, first_minimum=-math.inf):
    pair = _array(value, 2, 2)
    return [_number(pair[0], first_minimum), _number(pair[1])]


def validate_header(value, declaration=None):
    _require(type(value) is dict)
    kind = value.get("kind")
    _require(type(kind) is str and kind in ("chart", "table", "list", "code"))
    _object(value, ("kind", "timeDomain", "view", "series") if kind == "chart" else ("kind",))
    header = {"kind": kind}
    if kind == "chart":
        domain = _pair(value["timeDomain"])
        _require(domain[0] == 0 and domain[1] >= 1000)
        _require(type(value["view"]) is str and value["view"] in ("full", "recent60s"))
        series = []
        for item in _array(value["series"], 1, 2):
            _object(item, ("id", "unit", "range", "extrema", "fullPointCount", "omittedPoints", "omittedRuns"))
            extrema = item["extrema"]
            if extrema is not None:
                extrema = [_pair(pair, 0) for pair in _array(extrema, 2, 2)]
            current = {
                "id": _id(item["id"]), "unit": _text(item["unit"], 32),
                "range": _pair(item["range"]), "extrema": extrema,
                "fullPointCount": _counter(item["fullPointCount"], 3600),
                "omittedPoints": _counter(item["omittedPoints"], 3600),
                "omittedRuns": _counter(item["omittedRuns"], 3600),
            }
            low, high = current["range"]
            _require(low <= high and (current["fullPointCount"] == 0) == (extrema is None))
            _require(current["omittedRuns"] <= current["omittedPoints"] <= current["fullPointCount"])
            if extrema is not None:
                _require(extrema[0][1] <= extrema[1][1])
                _require(all(time <= domain[1] and low <= val <= high for time, val in extrema))
            series.append(current)
        _unique([s["id"] for s in series])
        header.update(timeDomain=domain, view=value["view"], series=series)
    if declaration is not None:
        d = validate_declaration(declaration)
        _require(d["kind"] == kind, "reference")
        if kind == "chart":
            _require([s["id"] for s in d["series"]] == [s["id"] for s in header["series"]], "reference")
    _require(len(_bytes(header)) <= 16384, "quota")
    return header


def _entries(kind, entries, maximum, declaration=None):
    parsed = []
    for entry in _array(entries, 0, maximum):
        if kind == "code":
            item = _text(entry, 1024, 1)
        elif kind == "chart":
            _array(entry, 4, 4)
            item = [_counter(entry[0]), _counter(entry[1]), _number(entry[2], 0), _number(entry[3])]
        else:
            _object(entry, ("key", "version", "cells"))
            cells = []
            for cell in _array(entry["cells"], 0, 3 if kind == "list" else 8):
                if type(cell) is str:
                    cells.append(_text(cell, 200))
                elif cell is None or type(cell) is bool:
                    cells.append(cell)
                else:
                    cells.append(_number(cell))
            if declaration is not None:
                columns = declaration["columns"]
                _require(len(cells) == len(columns), "reference")
                for cell, column in zip(cells, columns):
                    types = {"string": (str,), "number": (int, float), "boolean": (bool,)}
                    _require(cell is None or type(cell) in types[column["value"]], "reference")
            item = {"key": _text(entry["key"], 128, 1),
                    "version": None if entry["version"] is None else _text(entry["version"], 128, 1),
                    "cells": cells}
        _require(len(_bytes(item)) <= 8192, "quota")
        parsed.append(item)
    if kind in ("table", "list"):
        _unique([r["key"] for r in parsed])
    return parsed


def _chart_entries(header, entries, complete):
    counts = [0] * len(header["series"])
    previous = None
    for point in entries:
        index, run, time, value = point
        _require(index < len(counts), "reference")
        index = int(index)
        series = header["series"][index]
        _require(time <= header["timeDomain"][1] and series["range"][0] <= value <= series["range"][1])
        extrema = series["extrema"]
        _require(extrema is not None and extrema[0][1] <= value <= extrema[1][1])
        if previous is not None:
            _require(index > previous[0] or (index == previous[0] and
                     (run > previous[1] or (run == previous[1] and time >= previous[2]))))
        counts[index] += 1
        _require(counts[index] <= 800)
        previous = point
    if complete:
        for i, series in enumerate(header["series"]):
            _require(series["omittedPoints"] == series["fullPointCount"] - counts[i])
            for time, value in series["extrema"] or []:
                _require(any(p[0] == i and p[2] == time and p[3] == value for p in entries))


def validate_chunk(value, header=None, declaration=None):
    _object(value, ("kind", "entries"))
    kind = value["kind"]
    _require(type(kind) is str and kind in ("chart", "table", "list", "code"))
    d = validate_declaration(declaration) if declaration is not None else None
    if d is not None:
        _require(kind == d["kind"], "reference")
    entries = _entries(kind, value["entries"], 50 if kind in ("table", "list") else 256, d)
    if header is not None:
        h = validate_header(header, d)
        _require(h["kind"] == kind, "reference")
        if kind == "chart":
            _chart_entries(h, entries, False)
    chunk = {"kind": kind, "entries": entries}
    _require(len(_bytes(chunk)) <= 49152, "quota")
    return chunk


def _dataset(header, entries, declaration=None):
    h = validate_header(header, declaration)
    kind = h["kind"]
    parsed = _entries(kind, entries, {"chart": 1600, "table": 50, "list": 50, "code": 16384}[kind], declaration)
    if kind == "chart":
        _chart_entries(h, parsed, True)
    if kind == "code":
        code = "".join(parsed)
        _require(len(code) <= 16384 and len(code.encode("utf-8")) <= 65536, "quota")
    _require(len(_bytes([h, parsed])) <= 524288, "quota")
    return {"header": h, "entries": parsed}


def validate_dataset(declaration, header, entries):
    return _dataset(header, entries, validate_declaration(declaration))


def canonical_dataset_bytes(header, entries):
    """Semantic dataset validity; use validate_dataset for declaration admission."""
    data = _dataset(header, entries)
    return _bytes([data["header"], data["entries"]])


def canonical_chunk_bytes(value):
    return _bytes(validate_chunk(value))


def validate_panel(datasets):
    """Caller supplies each distinct committed dataset exactly once."""
    _array(datasets, 0, 8)
    byte_length = points = charts = codes = 0
    for item in datasets:
        _object(item, ("declaration", "header", "entries"))
        data = validate_dataset(item["declaration"], item["header"], item["entries"])
        byte_length += len(_bytes([data["header"], data["entries"]]))
        if data["header"]["kind"] == "chart":
            charts += 1
            points += len(data["entries"])
        if data["header"]["kind"] == "code":
            codes += 1
    _require(byte_length <= 524288 and points <= 6400 and charts <= 4 and codes <= 1, "quota")
    return {"byteLength": byte_length, "pointCount": points}
