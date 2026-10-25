"""Unpublished UI v2 data facade over the SDK's schema-validated RPC port.

The port validates method params/results, enforces timeout and propagates task
cancellation through the existing RPC cancel path. This facade adds dataset
semantics and ready-session fencing. It is not attached to Plugin until the
versioned protocol schemas and negotiation are integrated.
"""
import copy
from typing import Any, Protocol

from ._ui_v2_data import (
    _require, _object, _array, _counter, _id, _bytes,
    validate_header, validate_chunk,
)


class UiDataRequest(Protocol):
    async def __call__(self, method: str, params: dict[str, Any],
                       timeout: float = 5) -> dict[str, Any]: ...


def validate_read(value, request):
    """Semantic checks after structural protocol validation by the RPC port."""
    _require(value["revision"] == request["revision"], "reference")
    _counter(request["offset"])
    _counter(request["limit"], 256)
    _require(request["limit"] >= 1, "reference")
    header = validate_header(value["header"])
    chunk = validate_chunk(value["chunk"], header)
    count = len(chunk["entries"])
    _require(count <= request["limit"] and
             value["nextOffset"] == request["offset"] + count and
             (value["done"] or count > 0), "reference")
    _require(len(_bytes({"ok": True, "value": value})) <= 49152, "quota")
    return value


def validate_snapshot(value):
    """No payload cache: this returns bounded metadata supplied by the host."""
    _object(value, ("datasets",))
    entries = _array(value["datasets"], 0, 8)
    ids = [_id(entry["dataset"]) for entry in entries]
    _require(len(set(ids)) == len(ids), "reference")
    return value


class UiData:
    def __init__(self, request: UiDataRequest):
        self._request = request
        self._ready = False
        self._epoch = 0

    def mark_ready(self):
        self._epoch += 1
        self._ready = True

    def retire(self):
        self._epoch += 1
        self._ready = False

    async def _call(self, method, params):
        if not self._ready:
            raise RuntimeError("UI v2 data is not ready.")
        epoch = self._epoch
        # A caller changing its dict during an await cannot change page checks.
        params = copy.deepcopy(params)
        if method == "ui/dataBegin":
            validate_header(params["header"])
        elif method == "ui/dataChunk":
            validate_chunk(params["chunk"])
        result = await self._request(method, params, timeout=5)
        if not self._ready or epoch != self._epoch:
            raise RuntimeError("UI data session retired.")
        result = copy.deepcopy(result)
        if result["ok"]:
            if method == "ui/dataRead":
                validate_read(result["value"], params)
            elif method == "ui/dataSnapshot":
                validate_snapshot(result["value"])
        return result

    async def begin(self, params):
        return await self._call("ui/dataBegin", params)

    async def chunk(self, params):
        return await self._call("ui/dataChunk", params)

    async def commit(self, params):
        return await self._call("ui/dataCommit", params)

    async def abort(self, params):
        return await self._call("ui/dataAbort", params)

    async def read(self, params):
        return await self._call("ui/dataRead", params)

    async def snapshot(self, binding):
        return await self._call("ui/dataSnapshot", {"binding": binding})
