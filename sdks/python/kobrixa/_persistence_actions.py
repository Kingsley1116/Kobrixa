import re
from ._settings import PersistenceRequest, PersistenceClient, obj, text, integer
from ._storage import handle, canonical_base64_length, MEDIA_TYPES

def validate_copy(value):
    obj(value, ["actionRef", "text"]); handle(value["actionRef"]); text(value["text"], 0, 16384, 65536)
    return value

def validate_export(value):
    obj(value, ["actionRef", "suggestedName", "mediaType", "byteLength", "sha256"])
    handle(value["actionRef"]); text(value["suggestedName"], 1, 80, 320, True); integer(value["byteLength"], 0, 8388608)
    name = value["suggestedName"]
    if re.search(r"[\\/:]", name) or name in (".", "..") or re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name): raise ValueError("invalid-name")
    if value["mediaType"] not in MEDIA_TYPES or not isinstance(value["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["sha256"]): raise ValueError("invalid-metadata")
    return value

class PersistenceActions(PersistenceClient):
    async def export_begin(self, p): validate_export(p); return await self._call("storage/exportBegin", p)
    async def export_chunk(self, p): canonical_base64_length(p["data"]); return await self._call("storage/exportChunk", p)
    async def export_commit(self, p): return await self._call("storage/exportCommit", p)
    async def export_status(self, p): return await self._call("storage/exportStatus", p)
    async def export_cancel(self, p): return await self._call("storage/exportCancel", p)
    async def copy_text(self, p): validate_copy(p); return await self._call("ui/copyText", p)

def create_persistence_actions_client(request: PersistenceRequest) -> PersistenceActions:
    return PersistenceActions(request)
