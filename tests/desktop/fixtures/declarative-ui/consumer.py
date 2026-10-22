import asyncio
import sys
from kobrixa import Plugin

plugin = Plugin()
calls = 0
ticks = 0
producer = None
stopped = False

@plugin.context_command("acceptance.ui.inspect", {})
async def inspect(ctx):
    return {"output": {"has-binding": "binding" in ctx.context,
                       "has-motion": "motionScopeRef" in ctx.context,
                       "argument-count": len(ctx.arguments)}, "fieldErrors": []}

@plugin.command("acceptance.ui.legacy")
async def legacy(ctx):
    return None

@plugin.context_command("acceptance.ui.activate", {
    "speed": {"type": "number", "min": -100, "max": 100, "integer": True, "nullable": False},
    "mode": {"type": "enum", "values": ["coast", "brake"], "nullable": False},
})
async def activate(ctx):
    global calls
    if ctx.arguments["speed"] == -99:
        raise RuntimeError("fixture callback failed")
    if ctx.arguments["speed"] == -98:
        print("UI_CALLBACK_WAIT:" + ctx.invocation_id, file=sys.stderr, flush=True)
        await asyncio.sleep(60)
    calls += 1
    return {"output": {
        "calls": calls, "speed": ctx.arguments["speed"], "mode": ctx.arguments["mode"],
        "origin": ctx.context["origin"], "has-binding": "binding" in ctx.context,
        "has-motion": "motionScopeRef" in ctx.context, "unicode": "🙂界"
    }, "fieldErrors": []}

@plugin.context_command("acceptance.ui.hold", {
    "speed": {"type": "number", "min": -100, "max": 100, "integer": True, "nullable": False},
    "mode": {"type": "enum", "values": ["coast", "brake"], "nullable": False},
})
async def hold(ctx):
    return {"output": {
        "speed": ctx.arguments["speed"], "mode": ctx.arguments["mode"],
        "phase": ctx.context["trigger"].get("phase", "invalid")
    }, "fieldErrors": []}

@plugin.ready
async def ready(ctx):
    global producer
    def failed(code):
        global stopped
        if code == "PLUGIN_E_STALE_RESOURCE":
            stopped = True
        else:
            raise RuntimeError(code)
    async def tick():
        global ticks
        listed = await ctx.ui.instances()
        if stopped:
            return
        if not listed["ok"]:
            return failed(listed["error"]["code"])
        ticks += 1
        for binding in listed["value"]["instances"]:
            state = await ctx.ui.state(binding)
            if stopped:
                return
            if not state["ok"]:
                if state["error"]["code"] == "PLUGIN_E_STALE_RESOURCE":
                    continue
                return failed(state["error"]["code"])
            patched = await ctx.ui.patch(binding, state["value"]["revision"],
                                         {"ticks": "tick:" + str(ticks)})
            if stopped:
                return
            if not patched["ok"]:
                if patched["error"]["code"] == "PLUGIN_E_STALE_RESOURCE":
                    continue
                return failed(patched["error"]["code"])
    async def loop():
        while not stopped:
            started = asyncio.get_running_loop().time()
            await tick()
            if stopped:
                return
            await asyncio.sleep(max(0, 0.1 - (asyncio.get_running_loop().time() - started)))
    await tick()
    if not stopped:
        producer = asyncio.create_task(loop())

@plugin.deactivate
async def deactivate(*_args):
    global stopped
    stopped = True
    if producer is not None:
        producer.cancel()
        try:
            await producer
        except asyncio.CancelledError:
            pass

plugin.run()
