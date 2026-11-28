"""Synthetic Python SDK/stdin-out acceptance consumer; NOT the Sensor Lab product."""
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
from kobrixa import Plugin

ROLE = sys.argv[1]
ID = "acceptance.lab-stdio" + ("" if ROLE == "owner" else "-" + ROLE)
plugin = Plugin()
ready_event = asyncio.Event()
record = reservation = checkpoint = pin = binding = None
subscription = None
seen = []
PAYLOAD = b'{"fixture":"python-stdio","values":[42,null],"unicode":"\xce\xbb"}'
COPY = "Python stdio calibrated 42 \u03c0\U0001f642"


def value(result):
    assert result["ok"] is True, repr(result)
    return result["value"]


def denied(result, code=None):
    assert result["ok"] is False, repr(result)
    if code is not None:
        assert result["error"]["code"] == code, repr(result)
    return result["error"]["code"]


def note(stage, **fields):
    print("STDIO_RESULT:" + json.dumps({"role": ROLE, "stage": stage, **fields}), file=sys.stderr, flush=True)


async def write(storage, params, data, token=None):
    opened = value(await storage.begin_write({**params, "byteLength": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
    address = {"write": opened["write"]}
    value(await storage.write_chunk({**address, "offset": 0, "data": base64.b64encode(data).decode("ascii")}))
    value(await storage.seal_write(address))
    return opened["write"], value(await storage.commit_write({**address, **({"drainToken": token} if token else {})}))["record"]


def metadata():
    return {"kind": "acceptance.synthetic", "schemaVersion": 1, "label": "Synthetic Python parity", "mediaType": "application/json"}


@plugin.ready
async def ready(_ctx):
    ready_event.set()
    note("ready", pid=os.getpid())


@plugin.command(ID + ".run")
async def run(ctx):
    global binding, record, reservation, checkpoint, pin, subscription
    await asyncio.wait_for(ready_event.wait(), 5)
    if ROLE != "owner":
        # Deliberately disclosed original handles are attack inputs, never authority.
        foreign = json.loads(Path("reference.json").read_text())
        if ROLE == "foreign":
            denied(await ctx.ui.data.snapshot(foreign["binding"]), "PLUGIN_E_STALE_RESOURCE")
            denied(await ctx.storage.read_chunk({"read": foreign["read"], "offset": 0, "maxBytes": 256}))
            denied(await ctx.devices.recording.query({"reservationId": foreign["reservation"]}))
        else:
            denied(await ctx.ui.data.snapshot(foreign["binding"]), "PLUGIN_E_STALE_RESOURCE")
            denied(await ctx.storage.begin_write({**metadata(), "target": {"mode": "create"}, "byteLength": len(PAYLOAD), "sha256": hashlib.sha256(PAYLOAD).hexdigest()}), "PLUGIN_E_PERMISSION_DENIED")
        note("negative-done")
        return

    bindings = value(await ctx.ui.instances())["instances"]
    binding = next(b for b in bindings if b["kind"] == "panel")
    state = value(await ctx.ui.state(binding))
    patched = value(await ctx.ui.form_patch(binding, state["formRevision"], {"draft": "Python \u03c0\U0001f642"}))
    assert patched["formRevision"] == state["formRevision"] + 1
    denied(await ctx.ui.form_patch(binding, state["formRevision"], {"draft": "stale"}), "PLUGIN_E_STALE_RESOURCE")
    assert value(await ctx.ui.state(binding))["form"] == patched["form"]
    subscription = value(await ctx.ui.subscribe(["data"], lambda event: seen.append(event), binding))["subscriptionId"]
    header, entries = {"kind": "code"}, ["Python \u03c0\U0001f642\n", "raw=42\n"]
    canonical = json.dumps([header, entries], ensure_ascii=False, separators=(",", ":")).encode()
    address = {"binding": binding, "dataset": "code"}
    begin = {**address, "baseRevision": 0, "presentation": 1, "header": header, "entryCount": len(entries), "byteLength": len(canonical), "sha256": hashlib.sha256(canonical).hexdigest()}
    opened = value(await ctx.ui.data.begin(begin))
    transfer = {**address, "transfer": opened["transfer"]}
    chunk = {**transfer, "offset": 0, "chunk": {"kind": "code", "entries": entries}}
    assert value(await ctx.ui.data.chunk(chunk))["nextOffset"] == 2
    assert value(await ctx.ui.data.chunk(chunk))["nextOffset"] == 2
    committed = value(await ctx.ui.data.commit(transfer))
    assert committed["revision"] == 1 and committed["sha256"] == begin["sha256"]
    rebuilt = []
    for offset in range(3):
        page = value(await ctx.ui.data.read({**address, "revision": 1, "offset": offset, "limit": 1}))
        rebuilt.extend(page["chunk"]["entries"])
        assert page["nextOffset"] == min(offset + 1, 2)
    assert rebuilt == entries
    denied(await ctx.ui.data.read({**address, "revision": 2, "offset": 0, "limit": 1}), "PLUGIN_E_STALE_RESOURCE")
    assert value(await ctx.ui.data.snapshot(binding))["datasets"][0]["sha256"] == begin["sha256"]
    aborted = value(await ctx.ui.data.begin({**begin, "baseRevision": 1, "presentation": 2}))
    assert value(await ctx.ui.data.abort({**address, "transfer": aborted["transfer"]}))["aborted"]
    denied(await ctx.ui.data.commit({**address, "transfer": aborted["transfer"]}), "PLUGIN_E_STALE_RESOURCE")
    for _ in range(100):
        if any(e.get("kind") == "ui.data" for e in seen):
            break
        await asyncio.sleep(0.02)
    assert any(e.get("kind") == "ui.data" for e in seen), repr(seen)
    value(await ctx.ui.snapshot(subscription))
    value(await ctx.ui.unsubscribe(subscription))

    bad_ref = str(uuid.uuid4())
    denied(await ctx.actions.copy_text({"actionRef": bad_ref, "text": COPY}), "PLUGIN_E_PERMISSION_DENIED")
    export = {"actionRef": bad_ref, "suggestedName": "fixture.txt", "mediaType": "text/plain", "byteLength": 1, "sha256": hashlib.sha256(b"x").hexdigest()}
    denied(await ctx.actions.export_begin(export), "PLUGIN_E_PERMISSION_DENIED")
    # Missing actionRef is rejected locally by the public SDK, not claimed as a host response.
    missing = 0
    for callback, params in [(ctx.actions.copy_text, {"text": COPY}), (ctx.actions.export_begin, {k: v for k, v in export.items() if k != "actionRef"})]:
        try:
            await callback(params)
        except (ValueError, KeyError):
            missing += 1
    assert missing == 2
    sessions = value(await ctx.devices.list({}))["sessions"]
    session = value(await ctx.devices.session({"sessionId": sessions[0]["sessionId"]}))
    sources = session["sources"]
    reserved = value(await ctx.devices.recording.reserve({"sessionId": sessions[0]["sessionId"], "channelIds": [sources["channels"][0]["channelId"]], "expectedSourceRevision": sources["sourceRevision"]}))
    reservation = reserved["reservation"]["reservationId"]
    value(await ctx.devices.recording.read({"reservationId": reservation, "afterSequence": 0, "limit": 1}))
    _, record = await write(ctx.storage, {**metadata(), "target": {"mode": "create"}}, PAYLOAD)
    checkpoint = value(await ctx.storage.register_checkpoint({"id": record["id"], "expectedRevision": record["revision"], "reservation": reservation}))["checkpoint"]
    pin = value(await ctx.storage.open_read({"id": record["id"], "expectedRevision": record["revision"], "schemaVersion": 1}))["read"]
    note("started", missing_action_ref_local=missing, data_sha256=begin["sha256"])


if ROLE == "owner":
    @plugin.command(ID + ".finish")
    async def finish(ctx):
        value(await ctx.storage.close_read({"read": pin}))
        value(await ctx.devices.recording.release({"reservationId": reservation}))
        note("released")

    @plugin.command(ID + ".verify")
    async def verify(ctx):
        final = value(await ctx.storage.stat({"id": record["id"]}))["record"]
        assert final["checkpoint"] == "final" and final["revision"] != record["revision"]
        opened = value(await ctx.storage.open_read({"id": final["id"], "expectedRevision": final["revision"], "schemaVersion": 1}))
        page = value(await ctx.storage.read_chunk({"read": opened["read"], "offset": 0, "maxBytes": 262144}))
        assert page["eof"] is True
        data = base64.b64decode(page["data"], validate=True)
        assert data == PAYLOAD and hashlib.sha256(data).hexdigest() == final["sha256"]
        value(await ctx.storage.close_read({"read": opened["read"]}))
        note("verified", sha256=final["sha256"], record=final)

    @plugin.context_command(ID + ".copy", {})
    async def copy(ctx):
        ref = ctx.actions.actionRef  # actual bridge invocation, never constructed here
        assert value(await ctx.actions.copy_text({"actionRef": ref, "text": COPY}))["copied"]
        denied(await ctx.actions.copy_text({"actionRef": ref, "text": COPY}), "PLUGIN_E_PERMISSION_DENIED")
        return {"output": {"copied": True}, "fieldErrors": []}


@plugin.drain
async def drain(ctx):
    if not ctx.request["checkpoints"]:
        return {"ok": True, "value": {"status": "submitted", "writes": []}}
    assert ROLE == "owner"
    original = next(c for c in ctx.request["checkpoints"] if c["checkpoint"] == checkpoint)
    assert original["reservationEnd"]["reservationId"] == reservation
    params = {**metadata(), "target": {"mode": "replace", "id": original["record"]["id"], "expectedRevision": original["record"]["revision"]}, "checkpoint": {"handle": checkpoint, "phase": "final"}, "drainToken": ctx.request["token"]}
    denied(await ctx.storage.begin_write({**params, "drainToken": str(uuid.uuid4()), "byteLength": len(PAYLOAD), "sha256": hashlib.sha256(PAYLOAD).hexdigest()}))
    submitted, _ = await write(ctx.storage, params, PAYLOAD, ctx.request["token"])
    note("submitted", token=ctx.request["token"], write=submitted)
    return {"ok": True, "value": {"status": "submitted", "writes": [submitted]}}


plugin.run()
