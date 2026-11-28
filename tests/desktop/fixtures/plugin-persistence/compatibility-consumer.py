import base64
import hashlib
import json
import pathlib
import sys
from kobrixa import Plugin

plugin = Plugin()
identity = json.loads(pathlib.Path(__file__).with_name("kobrixa-plugin.json").read_text())["id"]
data = b"compatibility checkpoint\n"
metadata = dict(kind="test.compatibility", schemaVersion=1, label="Compatibility", mediaType="text/plain", byteLength=len(data), sha256=hashlib.sha256(data).hexdigest())

def value(result):
    assert result["ok"], result
    return result["value"]

async def publish(storage, target, **extra):
    write = value(await storage.begin_write(dict(metadata, target=target, **extra)))
    value(await storage.write_chunk(dict(write=write["write"], offset=0, data=base64.b64encode(data).decode())))
    value(await storage.seal_write(dict(write=write["write"])))
    commit = dict(write=write["write"])
    if "drainToken" in extra:
        commit["drainToken"] = extra["drainToken"]
    saved = value(await storage.commit_write(commit))
    return write["write"], saved["record"]

@plugin.command(identity + ".legacy")
async def legacy(_context):
    print("UI_LEGACY_EXECUTED:" + identity, file=sys.stderr, flush=True)

@plugin.command(identity + ".seed")
async def seed(context):
    _, record = await publish(context.storage, dict(mode="create"))
    value(await context.storage.register_checkpoint(dict(id=record["id"], expectedRevision=record["revision"])))

@plugin.drain
async def drain(context):
    request = context.request
    assert len(request["checkpoints"]) == 1
    writes = []
    for item in request["checkpoints"]:
        record = item["record"]
        write, _ = await publish(context.storage, dict(mode="replace", id=record["id"], expectedRevision=record["revision"]), checkpoint=dict(handle=item["checkpoint"], phase="final"), drainToken=request["token"])
        writes.append(write)
    return dict(ok=True, value=dict(status="submitted", writes=writes))

plugin.run()
