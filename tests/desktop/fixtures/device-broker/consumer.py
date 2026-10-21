import asyncio
import json
from pathlib import Path
from kobrixa import Plugin

plugin = Plugin()
fixture = json.loads(Path("fixture.json").read_text(encoding="utf-8"))


def value(result):
    if not result["ok"]:
        raise RuntimeError(result["error"]["code"] + ": " + result["error"]["message"])
    return result["value"]


@plugin.command("kobrixa-fixture.devices.probe")
async def probe(ctx):
    scenario = []
    devices = ctx.devices
    try:
        negotiated = value(await devices.negotiate())
    except Exception as error:
        if fixture.get("expectedRpcError") is not None and getattr(error, "code", None) == fixture["expectedRpcError"]:
            await ctx.ui.show_message(json.dumps({"ok": True, "rpcError": error.code}))
            return
        raise
    if fixture.get("expectedRpcError") is not None:
        raise RuntimeError("Host accepted hostile requirements")
    if negotiated["devicesContractVersion"] != 1:
        raise RuntimeError("Wrong contract version")
    if fixture.get("subscriptionProbe"):
        deliveries = 0
        async def delivered(event):
            nonlocal deliveries
            deliveries += 1
        pending = asyncio.create_task(devices.subscribe({"topic": "catalog"}, delivered))
        if fixture["subscriptionProbe"] == "subscribe-cancel":
            await ctx.ui.show_message(json.dumps({"readyToCancel": True}))
            pending.cancel()
        try:
            result = await pending
        except asyncio.CancelledError:
            await ctx.ui.show_message(json.dumps({"ok": True, "cancelled": True, "deliveries": deliveries}))
        except Exception as error:
            if getattr(error, "code", None) is None:
                raise
            await ctx.ui.show_message(json.dumps({"ok": True, "rpcError": error.code, "deliveries": deliveries}))
        else:
            if not result["ok"]:
                await ctx.ui.show_message(json.dumps({"ok": True, "businessError": result["error"]["code"], "deliveries": deliveries}))
            else:
                await ctx.ui.show_message(json.dumps({"eventBarrier": True}))
                await result["value"].close()
                await ctx.ui.show_message(json.dumps({"ok": True, "subscribed": True, "deliveries": deliveries}))
        return
    if fixture.get("negotiateOnly"):
        if negotiated["requirementsSatisfied"] != fixture["expectedSatisfied"]:
            raise RuntimeError("Requirements mismatch")
        await ctx.ui.show_message(json.dumps({"ok": True, "negotiated": negotiated}))
        return
    scenario.append("negotiate")
    listed = value(await devices.list({}))
    session_id = listed["sessions"][0]["sessionId"]
    scenario.append("list")
    sources = value(await devices.session({"sessionId": session_id}))["sources"]
    scenario.append("session")
    channels = [channel["channelId"] for channel in sources["channels"][:4]]
    value(await devices.read({"sessionId": session_id, "channelIds": channels, "freshness": "fresh"}))
    scenario.append("read")
    async def on_event(event):
        return None
    subscription = value(await devices.subscribe({"topic": "telemetry", "sessionId": session_id,
                                            "channelIds": channels, "intervalMs": 500}, on_event))
    scenario.append("subscribe")
    try:
        port = sources["channels"][0]["portId"]
        modes = value(await devices.input_modes.query({"sessionId": session_id, "portId": port,
                       "expectedSourceRevision": sources["sourceRevision"]}))
        scenario.append("mode-query")
        changed = value(await devices.input_modes.set({"sessionId": session_id, "portId": port,
                        "expectedSourceRevision": modes["sourceRevision"], "modeId": modes["modes"][0]["modeId"],
                        "contextRef": fixture["contextRef"]}))
        scenario.append("mode-set")
        fresh = [channel["channelId"] for channel in changed["sources"]["channels"][:4]]
        reserved = value(await devices.recording.reserve({"sessionId": session_id, "channelIds": fresh,
                         "expectedSourceRevision": changed["sources"]["sourceRevision"]}))
        reservation_id = reserved["reservation"]["reservationId"]
        scenario.append("reserve")
        value(await devices.recording.read({"reservationId": reservation_id, "afterSequence": 0, "limit": 64}))
        scenario.append("recording-read")
        value(await devices.recording.release({"reservationId": reservation_id}))
        scenario.append("release")
        prepared = value(await devices.motion.prepare({"sessionId": session_id,
                         "contextRef": fixture["contextRef"], "motionScopeRef": fixture["motionScopeRef"],
                         "motion": {"mode": "timed", "actuatorId": changed["sources"]["actuators"][0]["actuatorId"],
                                    "power": 1, "direction": 1, "brake": False, "durationMs": 100}}))
        operation_id = prepared["operation"]["operationId"]
        scenario.append("prepare")
        value(await devices.motion.start({"operationId": operation_id}))
        scenario.append("start")
        value(await devices.motion.stop({"operationId": operation_id, "stopMode": "brake"}))
        scenario.append("stop")
        deadline = asyncio.get_running_loop().time() + 20
        operation = value(await devices.motion.query({"operationId": operation_id}))["operation"]
        while operation["phase"] in ("preparing", "running", "stopping"):
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeError("Fixture stop did not settle")
            await asyncio.sleep(0.01)
            operation = value(await devices.motion.query({"operationId": operation_id}))["operation"]
        if operation["stopConfirmation"] != "confirmed" and operation["dispatch"] != "not-sent":
            raise RuntimeError("Fixture has unresolved stop outcome")
        scenario.append("query")
    finally:
        await subscription.close()
        await subscription.close()
    scenario.append("unsubscribe")
    await ctx.ui.show_message(json.dumps({"ok": True, "scenario": scenario}))


if __name__ == "__main__":
    plugin.run()
