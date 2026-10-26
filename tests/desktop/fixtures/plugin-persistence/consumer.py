import base64
import hashlib
from kobrixa import Plugin

plugin = Plugin()

def value(result):
    assert result["ok"] is True, "fixture business failure"
    return result["value"]

@plugin.command("test.persistence.run")
async def run(ctx):
    initial = value(await ctx.settings.read({"schemaVersion": 1}))
    watch = value(await ctx.settings.watch({"schemaVersion": 1}))
    updated = value(await ctx.settings.update({"schemaVersion": 1,
        "expectedRevision": initial["revision"], "changes": [{"key": "fixture.enabled", "value": True}]}))
    conflict = await ctx.settings.update({"schemaVersion": 1,
        "expectedRevision": initial["revision"], "changes": [{"key": "fixture.enabled", "value": False}]})
    assert conflict["ok"] is False
    assert conflict["error"]["code"] == "PLUGIN_E_SETTINGS_CONFLICT"
    assert updated["snapshot"]["revision"] != initial["revision"]
    reread = value(await ctx.settings.read({"schemaVersion": 1}))
    assert reread["revision"] == updated["snapshot"]["revision"]
    # Public event traces must separately establish actual watch invalidation/ACK.
    data = b"a" * 262144
    digest = hashlib.sha256(data).hexdigest()
    write = value(await ctx.storage.begin_write({"target": {"mode": "create"}, "kind": "test.fixture",
        "schemaVersion": 1, "label": "Synthetic record", "mediaType": "application/octet-stream",
        "byteLength": len(data), "sha256": digest}))
    value(await ctx.storage.write_chunk({"write": write["write"], "offset": 0,
        "data": base64.b64encode(data).decode("ascii")}))
    value(await ctx.storage.seal_write({"write": write["write"]}))
    committed = value(await ctx.storage.commit_write({"write": write["write"]}))
    duplicate = value(await ctx.storage.commit_write({"write": write["write"]}))
    assert duplicate["receipt"] == committed["receipt"]
    records = value(await ctx.storage.list({"kind": "test.fixture", "limit": 1}))
    assert len(records["entries"]) == 1
    read = value(await ctx.storage.open_read({"id": committed["record"]["id"],
        "expectedRevision": committed["record"]["revision"], "schemaVersion": 1}))
    chunk = value(await ctx.storage.read_chunk({"read": read["read"], "offset": 0, "maxBytes": 262144}))
    assert hashlib.sha256(base64.b64decode(chunk["data"], validate=True)).hexdigest() == digest
    assert chunk["eof"] is True
    value(await ctx.storage.close_read({"read": read["read"]}))
    value(await ctx.storage.flush({}))
    assert value(await ctx.settings.unwatch({"subscriptionId": watch["subscriptionId"]}))["removed"] is True
    assert value(await ctx.settings.unwatch({"subscriptionId": watch["subscriptionId"]}))["removed"] is False

@plugin.drain
async def drain(ctx):
    assert len(ctx.request["checkpoints"]) == 0
    value(await ctx.storage.flush({}))
    return {"ok": True, "value": {"status": "submitted", "writes": []}}

async def export_fixture(ctx):
    import asyncio
    action_ref = ctx.actions.actionRef  # SDK invocation context; never minted here.
    data = b"Synthetic persistence export\n"
    job = value(await ctx.actions.export_begin({"actionRef": action_ref,
        "suggestedName": "fixture.txt", "mediaType": "text/plain", "byteLength": len(data),
        "sha256": hashlib.sha256(data).hexdigest()}))
    deadline = asyncio.get_running_loop().time() + 10
    while True:
        status = value(await ctx.actions.export_status({"export": job["export"]}))
        if status["state"] == "cancelled":
            return {"cancelled": True}
        if status["state"] == "receiving":
            break
        assert status["state"] == "waiting"
        assert asyncio.get_running_loop().time() < deadline, "dialog observation deadline exceeded"
        await asyncio.sleep(0.025)
    value(await ctx.actions.export_chunk({"export": job["export"], "offset": 0,
        "data": base64.b64encode(data).decode("ascii")}))
    return value(await ctx.actions.export_commit({"export": job["export"]}))

async def copy_fixture(ctx):
    return value(await ctx.ui.copy_text({"actionRef": ctx.actions.actionRef,
        "text": "Synthetic persistence fixture"}))

if __name__ == "__main__":
    plugin.run()
