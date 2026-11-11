import base64
import hashlib
from kobrixa import Plugin

plugin = Plugin()
interop_active = False
interop_final = None

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
    if interop_active:
        return await interop_final(ctx)
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

def install_public_interop():
    import asyncio
    import json
    import os
    import pathlib
    import sys
    manifest = pathlib.Path(__file__).with_name("kobrixa-plugin.json")
    if not manifest.is_file() or json.loads(manifest.read_text())["id"] != "acceptance.interop-python":
        return
    identity = "acceptance.interop-python"
    records = []
    state = {}
    def emit(phase, data=None):
        print("PUBLIC_INTEROP:" + json.dumps(dict(phase=phase, pluginId=identity, pid=os.getpid(), data=data or {})), file=sys.stderr, flush=True)
    def payload(index):
        return bytes([97 + index]) * 262181
    async def publish(storage, index, **extra):
        data = payload(index)
        params = dict(target=dict(mode="create"), kind="test.interop", schemaVersion=1, label=f"Interop {index}",
                      mediaType="application/octet-stream", byteLength=len(data), sha256=hashlib.sha256(data).hexdigest())
        params.update(extra)
        write = value(await storage.begin_write(params))
        for offset in range(0, len(data), 262144):
            chunk = dict(write=write["write"], offset=offset, data=base64.b64encode(data[offset:offset+262144]).decode())
            value(await storage.write_chunk(chunk))
            if offset == 0:
                value(await storage.write_chunk(chunk))
        value(await storage.seal_write(dict(write=write["write"])))
        commit = dict(write=write["write"])
        if "drainToken" in extra:
            commit["drainToken"] = extra["drainToken"]
        saved = value(await storage.commit_write(commit))
        assert value(await storage.commit_write(commit))["receipt"] == saved["receipt"]
        return write["write"], saved["record"]
    async def read_all(ctx):
        for index, record in enumerate(records):
            read = value(await ctx.storage.open_read(dict(id=record["id"], expectedRevision=record["revision"], schemaVersion=1)))
            try:
                offset, digest = 0, hashlib.sha256()
                while offset < record["byteLength"]:
                    requested = min(262144, record["byteLength"] - offset)
                    chunk = value(await ctx.storage.read_chunk(dict(read=read["read"], offset=offset, maxBytes=requested)))
                    data = base64.b64decode(chunk["data"], validate=True)
                    assert 0 < len(data) <= requested and chunk["nextOffset"] == offset + len(data)
                    offset = chunk["nextOffset"]
                    assert chunk["eof"] == (offset == record["byteLength"])
                    digest.update(data)
                assert digest.hexdigest() == hashlib.sha256(payload(index)).hexdigest()
            finally:
                value(await ctx.storage.close_read(dict(read=read["read"])))
    @plugin.command(identity + ".interop-watch")
    async def watch(ctx):
        global interop_active
        interop_active = True
        state["gate"], state["done"] = asyncio.Event(), asyncio.Event()
        async def callback(notice):
            if notice["type"] != "event":
                return
            emit("callback-enter", notice["event"])
            await asyncio.wait_for(state["gate"].wait(), 10)
            emit("callback-complete", notice["event"])
            state["done"].set()
        initial = value(await ctx.settings.read(dict(schemaVersion=1)))
        state["subscription"] = value(await ctx.settings.watch(dict(schemaVersion=1), callback))["subscriptionId"]
        updated = value(await ctx.settings.update(dict(schemaVersion=1, expectedRevision=initial["revision"],
            changes=[dict(key="fixture.enabled", value=not next(entry["value"] for entry in initial["values"] if entry["key"] == "fixture.enabled"))])))
        conflict = await ctx.settings.update(dict(schemaVersion=1, expectedRevision=initial["revision"], changes=[dict(key="fixture.enabled", value=False)]))
        assert not conflict["ok"] and conflict["error"]["code"] == "PLUGIN_E_SETTINGS_CONFLICT"
        assert value(await ctx.settings.read(dict(schemaVersion=1)))["revision"] == updated["snapshot"]["revision"]
        emit("watch-ready", dict(subscription=state["subscription"]))
    @plugin.command(identity + ".interop-release")
    async def release(_ctx):
        emit("callback-release")
        state["gate"].set()
        await asyncio.wait_for(state["done"].wait(), 10)
    @plugin.command(identity + ".interop-records")
    async def create_records(ctx):
        assert not records
        for index in range(2):
            _, record = await publish(ctx.storage, index)
            records.append(record)
        listed, cursor = [], None
        while True:
            params = dict(kind="test.interop", limit=1)
            if cursor:
                params["cursor"] = cursor
            page = value(await ctx.storage.list(params))
            listed.extend(row["id"] for row in page["entries"])
            cursor = page.get("nextCursor")
            if not cursor:
                break
        assert sorted(listed) == sorted(row["id"] for row in records)
        await read_all(ctx)
        state["read"] = value(await ctx.storage.open_read(dict(id=records[0]["id"], expectedRevision=records[0]["revision"], schemaVersion=1)))["read"]
        emit("records", dict(records=records, read=state["read"], quota=value(await ctx.storage.quota({}))))
    negative_bytes = b"W10 retained record\n"
    negative_input = dict(kind="test.negative", schemaVersion=1, label="W10 retained",
                          mediaType="application/octet-stream", byteLength=len(negative_bytes),
                          sha256=hashlib.sha256(negative_bytes).hexdigest())
    async def negative_snapshot(ctx):
        settings = value(await ctx.settings.read(dict(schemaVersion=1)))
        listed = value(await ctx.storage.list(dict(kind="test.negative", limit=64)))
        assert len(listed["entries"]) == 1
        record = listed["entries"][0]
        read = value(await ctx.storage.open_read(dict(id=record["id"], expectedRevision=record["revision"], schemaVersion=1)))["read"]
        try:
            chunk = value(await ctx.storage.read_chunk(dict(read=read, offset=0, maxBytes=262144)))
            assert base64.b64decode(chunk["data"], validate=True) == negative_bytes and chunk["eof"]
            assert record["sha256"] == negative_input["sha256"]
        finally:
            value(await ctx.storage.close_read(dict(read=read)))
        return dict(settings=settings, record=record, quota=value(await ctx.storage.quota({})))
    @plugin.command(identity + ".negative-prepare")
    async def negative_prepare(ctx):
        state["negative"] = True
        write = value(await ctx.storage.begin_write(dict(negative_input, target=dict(mode="create"))))["write"]
        value(await ctx.storage.write_chunk(dict(write=write, offset=0, data=base64.b64encode(negative_bytes).decode())))
        value(await ctx.storage.seal_write(dict(write=write)))
        value(await ctx.storage.commit_write(dict(write=write)))
        emit("negative-prepared", await negative_snapshot(ctx))
    @plugin.command(identity + ".negative-reopen")
    async def negative_reopen(ctx):
        state["negative"] = True
        emit("negative-reopened", await negative_snapshot(ctx))
    @plugin.command(identity + ".negative-probe")
    async def negative_probe(ctx):
        state["negative"] = True
        baseline = await negative_snapshot(ctx)
        emit("negative-before", baseline)
        async def denied(scenario, code, call):
            emit("negative-start", dict(scenario=scenario))
            result = await call()
            emit("negative-result", dict(scenario=scenario, result=result))
            assert result["ok"] is False and result["error"]["code"] == code, scenario
        for scenario, key, invalid in [("unknown-setting", "unknown", True), ("setting-type", "fixture.enabled", "true")]:
            await denied(scenario, "PLUGIN_E_SETTINGS_SCHEMA", lambda: ctx.settings.update(dict(schemaVersion=1,
                expectedRevision=baseline["settings"]["revision"], changes=[dict(key=key, value=invalid)])))
        stages = []
        async def begin(target=None):
            write = value(await ctx.storage.begin_write(dict(negative_input, target=target or dict(mode="create"))))["write"]
            stages.append(write)
            return write
        async def abort(write):
            value(await ctx.storage.abort_write(dict(write=write)))
            stages.remove(write)
        try:
            target = dict(mode="replace", id=baseline["record"]["id"], expectedRevision=baseline["record"]["revision"])
            replacement = await begin(target)
            await denied("replacement-busy", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.begin_write(dict(negative_input, target=target)))
            await denied("delete-busy", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.delete(dict(id=target["id"], expectedRevision=target["expectedRevision"])))
            await abort(replacement)
            first, second = await begin(), await begin()
            await denied("staging-quota", "PLUGIN_E_STORAGE_QUOTA", lambda: ctx.storage.begin_write(dict(negative_input, target=dict(mode="create"))))
            await abort(second)
            value(await ctx.storage.write_chunk(dict(write=first, offset=0, data=base64.b64encode(negative_bytes).decode())))
            await denied("chunk-offset", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.write_chunk(dict(write=first, offset=len(negative_bytes)+1, data="Yg==")))
            await denied("chunk-retry-mismatch", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.write_chunk(dict(write=first, offset=0, data=base64.b64encode(b"b" * len(negative_bytes)).decode())))
            await denied("flush-incomplete", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.flush({}))
            await abort(first)
            await denied("aborted-write", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.write_chunk(dict(write=first, offset=0, data="Yg==")))
            wrong = await begin()
            value(await ctx.storage.write_chunk(dict(write=wrong, offset=0, data=base64.b64encode(b"b" * len(negative_bytes)).decode())))
            await denied("seal-checksum", "PLUGIN_E_STORAGE_CONFLICT", lambda: ctx.storage.seal_write(dict(write=wrong)))
            await abort(wrong)
            read = value(await ctx.storage.open_read(dict(id=baseline["record"]["id"], expectedRevision=baseline["record"]["revision"], schemaVersion=1)))["read"]
            value(await ctx.storage.close_read(dict(read=read)))
            await denied("closed-read", "PLUGIN_E_STALE_RESOURCE", lambda: ctx.storage.read_chunk(dict(read=read, offset=0, maxBytes=1)))
            forged = "00000000-0000-4000-8000-000000000001"
            await denied("copy-without-action", "PLUGIN_E_PERMISSION_DENIED", lambda: ctx.ui.copy_text(dict(actionRef=forged, text="forbidden")))
            await denied("export-without-action", "PLUGIN_E_PERMISSION_DENIED", lambda: ctx.actions.export_begin(dict(actionRef=forged, suggestedName="forbidden.txt", mediaType="text/plain", byteLength=1, sha256=hashlib.sha256(b"x").hexdigest())))
        finally:
            for write in list(stages):
                await abort(write)
        value(await ctx.storage.flush({}))
        after = await negative_snapshot(ctx)
        assert after == baseline
        emit("negative-after", after)
    text = dict(type="string", maxLength=128, nullable=False)
    @plugin.context_command(identity + ".interop-foreign", dict(id=text, revision=text, read=text))
    async def foreign(ctx):
        args = ctx.invocation["arguments"]
        for result in [await ctx.storage.open_read(dict(id=args["id"], expectedRevision=args["revision"], schemaVersion=1)),
                       await ctx.storage.read_chunk(dict(read=args["read"], offset=0, maxBytes=1))]:
            assert not result["ok"] and result["error"]["code"] in ("PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE")
        emit("foreign-denied", args)
        return dict(output=dict(done=True), fieldErrors=[])
    @plugin.command(identity + ".interop-verify")
    async def verify(ctx):
        await read_all(ctx)
        emit("verified", dict(records=records, quota=value(await ctx.storage.quota({}))))
        value(await ctx.storage.close_read(dict(read=state.pop("read"))))
        assert value(await ctx.settings.unwatch(dict(subscriptionId=state["subscription"])))["removed"] is True
        assert value(await ctx.settings.unwatch(dict(subscriptionId=state["subscription"])))["removed"] is False
        value(await ctx.storage.flush({}))
    @plugin.context_command(identity + ".interop-export")
    async def export(ctx):
        result = await export_fixture(ctx)
        assert "cancelled" not in result
        emit("export", dict(invocationId=ctx.invocation["invocationId"], actionRef=ctx.actions.actionRef, result=result))
        return dict(output=dict(done=True), fieldErrors=[])
    @plugin.context_command(identity + ".interop-copy")
    async def copy(ctx):
        result = await copy_fixture(ctx)
        emit("copy", dict(invocationId=ctx.invocation["invocationId"], actionRef=ctx.actions.actionRef, result=result))
        return dict(output=dict(done=True), fieldErrors=[])
    @plugin.context_command(identity + ".interop-replay", {"action-ref": text})
    async def replay(ctx):
        result = await ctx.ui.copy_text(dict(actionRef=ctx.invocation["arguments"]["action-ref"], text="forbidden replay"))
        assert not result["ok"] and result["error"]["code"] == "PLUGIN_E_PERMISSION_DENIED"
        emit("replay-denied", result)
        return dict(output=dict(done=True), fieldErrors=[])
    @plugin.command(identity + ".interop-checkpoint")
    async def checkpoint(ctx):
        emit("checkpoint", value(await ctx.storage.register_checkpoint(dict(id=records[0]["id"], expectedRevision=records[0]["revision"]))))
    async def final(ctx):
        request = ctx.request
        if state.get("negative"):
            assert not request["checkpoints"]
            value(await ctx.storage.flush({}))
            return dict(ok=True, value=dict(status="submitted", writes=[]))
        assert len(request["checkpoints"]) == 1
        emit("drain-enter", request)
        item = request["checkpoints"][0]
        write, _ = await publish(ctx.storage, 0, target=dict(mode="replace", id=item["record"]["id"], expectedRevision=item["record"]["revision"]),
            checkpoint=dict(handle=item["checkpoint"], phase="final"), drainToken=request["token"])
        value(await ctx.storage.flush({}))
        emit("drain-submitted", dict(token=request["token"], write=write))
        return dict(ok=True, value=dict(status="submitted", writes=[write]))
    global interop_final
    interop_final = final
    emit("boot")

install_public_interop()

if __name__ == "__main__":
    plugin.run()
