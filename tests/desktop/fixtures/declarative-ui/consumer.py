import asyncio
from kobrixa import Plugin

plugin = Plugin()
calls = 0
ticks = 0
producer = None
stopped = False

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
        await asyncio.sleep(60)
    calls += 1
    return {"output": {
        "calls": calls, "speed": ctx.arguments["speed"], "mode": ctx.arguments["mode"],
        "origin": ctx.context["origin"], "hasBinding": "binding" in ctx.context,
        "hasMotion": "motionScopeRef" in ctx.context, "unicode": "🙂界"
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
                return failed(state["error"]["code"])
            patched = await ctx.ui.patch(binding, state["value"]["revision"],
                                         {"ticks": "tick:" + str(ticks)})
            if stopped:
                return
            if not patched["ok"]:
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
