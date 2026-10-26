import json
import pathlib
import sys
from kobrixa import Plugin


class ObservedPlugin(Plugin):
    """Only records the unchanged SDK's framing/dispatch boundary."""
    def _receive(self, text):
        print("UI_LEGACY_WIRE:" + json.dumps({"direction": "host", "message": json.loads(text)}), file=sys.stderr, flush=True)
        return super()._receive(text)

    def _send(self, message):
        print("UI_LEGACY_WIRE:" + json.dumps({"direction": "plugin", "message": message}), file=sys.stderr, flush=True)
        return super()._send(message)


plugin = ObservedPlugin()
identity = json.loads(pathlib.Path(__file__).with_name("kobrixa-plugin.json").read_text())["id"]


@plugin.command(identity + ".legacy")
async def legacy(_context):
    print("UI_LEGACY_EXECUTED:" + identity, file=sys.stderr, flush=True)


plugin.run()
