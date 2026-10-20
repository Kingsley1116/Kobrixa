import re
from ._settings import PersistenceRequest, PersistenceClient, integer, text, obj, HANDLE, REVISION

MEDIA_TYPES = ("application/json", "text/plain", "text/csv", "application/octet-stream")

def canonical_base64_length(value, allow_empty=False):
    if value == "" and allow_empty: return 0
    if not isinstance(value, str) or not value or len(value) > 349528 or len(value) % 4 or not re.fullmatch(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?", value): raise ValueError("invalid-base64")
    padding = 2 if value.endswith("==") else 1 if value.endswith("=") else 0
    last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".index(value[-padding - 1])
    if (padding == 2 and last & 15) or (padding == 1 and last & 3): raise ValueError("invalid-tail-bits")
    size = len(value) // 4 * 3 - padding
    integer(size, 1, 262144)
    return size

def handle(value):
    if not isinstance(value, str) or not HANDLE.fullmatch(value): raise ValueError("invalid-handle")

def validate_record_write(value):
    obj(value, ["target", "kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"], ["checkpoint", "drainToken"])
    target = value["target"]
    if not isinstance(target, dict): raise ValueError("invalid-target")
    if target.get("mode") == "create": obj(target, ["mode"])
    else:
        obj(target, ["mode", "id", "expectedRevision"])
        if target["mode"] != "replace": raise ValueError("invalid-target")
        handle(target["id"])
        if not isinstance(target["expectedRevision"], str) or not REVISION.fullmatch(target["expectedRevision"]): raise ValueError("invalid-revision")
    if not isinstance(value["kind"], str) or not re.fullmatch(r"[a-z][a-z0-9.-]{0,63}", value["kind"]): raise ValueError("invalid-kind")
    integer(value["schemaVersion"], 1, 2147483647); integer(value["byteLength"], 0, 8388608)
    text(value["label"], 0, 160, 640, True)
    if value["mediaType"] not in MEDIA_TYPES or not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]): raise ValueError("invalid-metadata")
    if "drainToken" in value: handle(value["drainToken"])
    if "checkpoint" in value:
        obj(value["checkpoint"], ["handle", "phase"]); handle(value["checkpoint"]["handle"])
        if value["checkpoint"]["phase"] not in ("checkpoint", "final"): raise ValueError("invalid-checkpoint")
    return value

def drain_submission(value):
    obj(value, ["status", "writes"])
    if value["status"] not in ("submitted", "checkpoint-only") or not isinstance(value["writes"], list) or len(value["writes"]) > 2: raise ValueError("invalid-drain")
    for h in value["writes"]: handle(h)
    return {"status": value["status"], "writes": list(value["writes"])}

class Storage(PersistenceClient):
    async def begin_write(self, p): validate_record_write(p); return await self._call("storage/beginWrite", p)
    async def write_chunk(self, p): canonical_base64_length(p["data"]); return await self._call("storage/writeChunk", p)
    async def seal_write(self, p): return await self._call("storage/sealWrite", p)
    async def commit_write(self, p): return await self._call("storage/commitWrite", p)
    async def write_status(self, p): return await self._call("storage/writeStatus", p)
    async def abort_write(self, p): return await self._call("storage/abortWrite", p)
    async def stat(self, p): return await self._call("storage/stat", p)
    async def list(self, p): return await self._call("storage/list", p)
    async def open_read(self, p): return await self._call("storage/openRead", p)
    async def read_chunk(self, p): return await self._call("storage/readChunk", p)
    async def close_read(self, p): return await self._call("storage/closeRead", p)
    async def delete(self, p): return await self._call("storage/delete", p)
    async def flush(self, p): return await self._call("storage/flush", p)
    async def quota(self, p): return await self._call("storage/quota", p)
    async def register_checkpoint(self, p): return await self._call("storage/registerCheckpoint", p)
    async def abandon_checkpoint(self, p): return await self._call("storage/abandonCheckpoint", p)
    async def drain(self, p): return await self._call("storage/drain", p)

def create_storage_client(request: PersistenceRequest) -> Storage:
    return Storage(request)
