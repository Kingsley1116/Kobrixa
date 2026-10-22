import asyncio
import unittest
from kobrixa._events import EventInbox

ID='00000000-0000-4000-8000-000000000001'
def event(sequence):
    return {'version':1,'subscriptionId':ID,'owner':{'sourceKey':'builtin:acme.test','pluginId':'acme.test','generation':1,'hostEpoch':ID,'processEpoch':ID},'sequence':sequence,'delivery':'control','kind':'events.resyncRequired','data':{'reason':'overflow','affected':[ID]}}

class EventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_ack_before_hung_callback_and_bounded_queue(self):
        accepted=[]
        async def ack(id,sequence): accepted.append(sequence)
        async def listener(value): await asyncio.Future()
        async def refresh(): pass
        inbox=EventInbox(ack,event(1)["owner"])
        self.assertFalse(inbox.accept(event(1)))
        inbox.enable();inbox.open(ID,listener,refresh)
        for sequence in range(1,9): self.assertTrue(inbox.accept(event(sequence)))
        self.assertFalse(inbox.accept(event(9)))
        self.assertFalse(inbox.accept(event(1)))
        await asyncio.sleep(0)
        self.assertEqual(accepted,list(range(1,9)))
        inbox.close(ID)

    async def test_binding_is_one_shot_and_close_cancels_all_inbox_tasks(self):
        from kobrixa._events import bind_event_channel, close_event_channel, _BOUND
        from kobrixa._devices import Devices
        started=[]
        class Peer:
            async def _request(self,*args,**kwargs):
                started.append(asyncio.current_task())
                await asyncio.Future()
        peer=Peer();peer.devices=Devices(peer._request)
        bind_event_channel(peer,event(1)['owner'])
        inbox=peer.devices.inbox;inbox.enable()
        async def listener(value): await asyncio.Future()
        async def refresh(): pass
        inbox.open(ID,listener,refresh)
        self.assertTrue(inbox.accept(event(1)))
        await asyncio.sleep(0)
        close_event_channel(peer)
        await asyncio.sleep(0)
        self.assertNotIn(peer,_BOUND)
        self.assertIsNone(peer.devices.inbox)
        self.assertTrue(all(task.cancelled() for task in started))
        with self.assertRaises(ValueError):bind_event_channel(peer,event(1)['owner'])

OWNER = event(1)["owner"]

class UiCommonEventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_gap_snapshot_race_and_close(self):
        ack, callbacks = [], []
        gate = asyncio.Event()
        async def acknowledge(id, sequence):
            ack.append(sequence)
        inbox = EventInbox(acknowledge, OWNER)
        inbox.enable()
        id = "00000000-0000-4000-8000-000000000090"
        async def snapshot():
            await gate.wait()
            inbox.reconcile(id, 3)
        inbox.open(id, lambda event: callbacks.append(event["sequence"]), snapshot)
        def event(sequence):
            return {"version":1,"owner":OWNER,"subscriptionId":id,"sequence":sequence,
                    "delivery":"control","kind":"ui.environment","data":{"locale":"en","theme":"dark"}}
        for sequence in (2, 3, 4):
            self.assertTrue(inbox.accept(event(sequence)))
        await asyncio.sleep(0)
        self.assertEqual(ack, [2, 3, 4])
        self.assertEqual(callbacks, [])
        gate.set()
        for _ in range(5):
            await asyncio.sleep(0)
        self.assertEqual(callbacks, [4])
        self.assertFalse(inbox.accept(event(4)))
        inbox.close(id)
        self.assertFalse(inbox.accept(event(5)))

    async def test_mixed_domain_saturation_and_callback_failure(self):
        ack, entered = [], []
        gate = asyncio.Event()
        async def acknowledge(id, sequence):
            ack.append((id, sequence))
        async def callback(event):
            entered.append(event["sequence"])
            await gate.wait()
            raise ValueError("isolated callback failure")
        inbox = EventInbox(acknowledge, OWNER)
        inbox.enable()
        ids = ["00000000-0000-4000-8000-000000000091", "00000000-0000-4000-8000-000000000092"]
        async def snapshot():
            return None
        for id in ids:
            inbox.open(id, callback, snapshot)
        for sequence in range(1, 5):
            for index, id in enumerate(ids):
                kind = "devices.catalog" if index == 0 else "ui.environment"
                data = {"revision":sequence,"providers":[],"sessions":[]} if index == 0 else {"locale":"en","theme":"dark"}
                self.assertTrue(inbox.accept({"version":1,"owner":OWNER,"subscriptionId":id,
                    "sequence":sequence,"delivery":"control","kind":kind,"data":data}))
        await asyncio.sleep(0)
        self.assertEqual(len(ack), 8)
        self.assertFalse(inbox.accept({"version":1,"owner":OWNER,"subscriptionId":ids[1],
            "sequence":5,"delivery":"control","kind":"ui.environment","data":{"locale":"en","theme":"dark"}}))
        gate.set()
        for _ in range(12):
            await asyncio.sleep(0)
        self.assertEqual(len(entered), 8)
        for id in ids:
            inbox.close(id)

    async def test_terminal_adapter_retains_delivery_until_callback_then_forgets(self):
        from types import SimpleNamespace
        from kobrixa._events import bind_event_channel, ui_event_client_port, _BOUND
        class Peer:
            def __init__(self):
                self.devices = SimpleNamespace(inbox=None)
                self.requests = []
            async def _request(self, method, params):
                self.requests.append((method, params))
                return {"ok":True,"value":{"acknowledged":params["sequence"]}}
        peer = Peer()
        bind_event_channel(peer, OWNER)
        port = ui_event_client_port(peer)
        id = "00000000-0000-4000-8000-000000000093"
        seen = []
        binding = {"contributionId":"acme.test.panel","panelInstance":id,"kind":"panel",
                   "uiResourceGeneration":1,"generation":OWNER["generation"],
                   "hostEpoch":OWNER["hostEpoch"],"processEpoch":OWNER["processEpoch"]}
        async def snapshot():
            return {"ok":True,"value":{"sequence":0,"snapshot":{"instances":[],"states":[],"locale":"en","theme":"light"}}}
        async def callback(event):
            self.assertEqual(peer.requests[0][0], "events/ack")
            seen.append(event["kind"])
            port.forget(id)
        port.adopt(subscription_id=id, sequence=0, snapshot=snapshot, listener=callback)
        self.assertTrue(_BOUND[peer].accept({"version":1,"owner":OWNER,"subscriptionId":id,
            "sequence":1,"delivery":"control","kind":"ui.revoked","data":{"binding":binding,"reason":"closed"}}))
        for _ in range(5):
            await asyncio.sleep(0)
        self.assertEqual(seen, ["ui.revoked"])
        self.assertNotIn(id, _BOUND[peer]._slots)

class SettingsCommonEventsTests(unittest.IsolatedAsyncioTestCase):
    async def test_settings_gap_ack_and_unwatch_use_the_shared_queue(self):
        from kobrixa._events import bind_event_channel, close_event_channel, settings_event_client
        from kobrixa._settings import create_settings_client
        from kobrixa._devices import Devices
        order = []
        snapshot = {"schemaVersion": 1, "revision": None, "values": []}
        class Peer:
            async def _request(self, method, params):
                if method == "settings/watch":
                    return {"ok": True, "value": {"subscriptionId": ID, "sequence": 0, "snapshot": snapshot}}
                if method == "settings/read":
                    order.append("read")
                    return {"ok": True, "value": snapshot}
                if method == "events/ack":
                    order.append("ack")
                    return {"ok": True, "value": {"acknowledged": params["sequence"]}}
                if method == "events/unsubscribe":
                    return {"ok": True, "value": {"removed": True}}
                raise AssertionError(method)
        peer = Peer()
        peer.devices = Devices(peer._request)
        bind_event_channel(peer, OWNER)
        client = settings_event_client(peer, create_settings_client(peer._request))
        try:
            await client.watch({"schemaVersion": 1}, lambda e: order.append("callback"))
            changed = dict(event(2), delivery="telemetry", kind="settings.changed", data={
                "revision": "r_" + "1" * 32, "schemaVersion": 1, "changedKeys": ["fixture.enabled"], "cause": "update"})
            self.assertFalse(peer.devices.inbox.accept(dict(changed, owner=dict(OWNER, generation=2))))
            self.assertFalse(peer.devices.inbox.accept(dict(changed, data=dict(changed["data"], values=[]))))
            self.assertTrue(peer.devices.inbox.accept(changed))
            for _ in range(10):
                if "callback" in order: break
                await asyncio.sleep(0)
            self.assertLess(order.index("ack"), order.index("callback"))
            self.assertLess(order.index("read"), order.index("callback"))
            await client.unwatch({"subscriptionId": ID})
            self.assertFalse(peer.devices.inbox.accept(dict(changed, sequence=3)))
        finally:
            close_event_channel(peer)
