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


class T8SettingsTests(unittest.IsolatedAsyncioTestCase):
    async def test_actual_resync_snapshot_and_gap(self):
        from types import SimpleNamespace
        from kobrixa._events import bind_event_channel, close_event_channel, settings_event_client
        from kobrixa._settings import create_settings_client
        for marker in (True, False):
            notices, order = [], []
            initial = {"schemaVersion":1,"revision":None,"values":[{"key":"fixture.enabled","value":False}]}
            fresh = dict(initial, values=[{"key":"fixture.enabled","value":True}])
            class Peer:
                async def _request(self, method, params):
                    if method == "settings/watch": return {"ok":True,"value":{"subscriptionId":ID,"sequence":0,"snapshot":initial}}
                    if method == "settings/read":
                        order.append("read")
                        return {"ok":True,"value":fresh}
                    if method == "events/ack":
                        order.append("ack")
                        return {"ok":True,"value":{}}
                    raise AssertionError(method)
            peer=Peer();peer.devices=SimpleNamespace(inbox=None)
            bind_event_channel(peer, OWNER)
            async def listener(notice):
                order.append("callback");notices.append(notice)
                await asyncio.sleep(0)
            try:
                result=await settings_event_client(peer,create_settings_client(peer._request)).watch({"schemaVersion":1},listener)
                self.assertFalse(result["value"]["snapshot"]["values"][0]["value"])
                envelope=event(1) if marker else dict(event(2),delivery="telemetry",kind="settings.changed",data={"revision":"r_"+"1"*32,"schemaVersion":1,"changedKeys":["fixture.enabled"],"cause":"update"})
                self.assertTrue(peer.devices.inbox.accept(envelope))
                for _ in range(10): await asyncio.sleep(0)
                self.assertEqual(notices, [{"type":"snapshot","snapshot":fresh}] + ([] if marker else [{"type":"event","event":envelope}]))
                self.assertLess(order.index("ack"),order.index("callback"))
            finally: close_event_channel(peer)

    async def test_settings_keys_validator_and_bound_inbox(self):
        from types import SimpleNamespace
        from kobrixa._events import bind_event_channel, close_event_channel
        from kobrixa._schema import Validator, SchemaError
        acks=[]
        class Peer:
            async def _request(self,method,params): acks.append(params)
        peer=Peer();peer.devices=SimpleNamespace(inbox=None)
        bind_event_channel(peer,OWNER)
        inbox=peer.devices.inbox;inbox.enable()
        async def noop(): pass
        inbox.open(ID,lambda e:None,noop)
        validator=Validator.bundled()
        try:
            for key in ("constructor","prototype","__proto__","foo.constructor","prototype.foo","foo.__proto__.bar"):
                envelope=dict(event(1),delivery="telemetry",kind="settings.changed",data={"revision":"r_"+"1"*32,"schemaVersion":1,"changedKeys":[key],"cause":"update"})
                with self.subTest(key=key):
                    with self.assertRaises(SchemaError): validator.validate("events/deliver.params",envelope)
                    self.assertFalse(inbox.accept(envelope))
            await asyncio.sleep(0)
            self.assertEqual(acks,[])
            envelope["data"]["changedKeys"]=["fixture.enabled","fixture.enabled","constructorName.x"]
            validator.validate("events/deliver.params",envelope)
            self.assertTrue(inbox.accept(envelope))
            for _ in range(3): await asyncio.sleep(0)
            self.assertEqual(len(acks), 1)
        finally: close_event_channel(peer)

    async def test_late_refresh_and_callback_failure(self):
        from types import SimpleNamespace
        from kobrixa._events import bind_event_channel, close_event_channel, settings_event_client
        from kobrixa._settings import create_settings_client
        for stop in ("unwatch", "inbox-close", "dispose", "callback-error"):
            notices, acks = [], []
            gate, reading, callback_gate = asyncio.Event(), asyncio.Event(), asyncio.Event()
            snapshot={"schemaVersion":1,"revision":None,"values":[]}
            class Peer:
                async def _request(self,method,params):
                    if method == "settings/watch": return {"ok":True,"value":{"subscriptionId":ID,"sequence":0,"snapshot":snapshot}}
                    if method == "settings/read":
                        reading.set()
                        try: await gate.wait()
                        except asyncio.CancelledError:
                            # A real request may finish despite cancellation; ownership must still guard delivery.
                            await gate.wait()
                        return {"ok":True,"value":snapshot}
                    if method == "events/ack":
                        acks.append(params["sequence"])
                        return {"ok":True,"value":{}}
                    if method == "events/unsubscribe":return {"ok":True,"value":{"removed":True}}
                    raise AssertionError(method)
            peer=Peer();peer.devices=SimpleNamespace(inbox=None)
            bind_event_channel(peer,OWNER)
            inbox=peer.devices.inbox
            async def listener(notice):
                notices.append(notice)
                if notice["type"] == "snapshot":
                    await callback_gate.wait()
                    raise ValueError("consumer")
            client=settings_event_client(peer,create_settings_client(peer._request))
            try:
                await client.watch({"schemaVersion":1},listener)
                self.assertTrue(inbox.accept(event(1)))
                await reading.wait()
                self.assertEqual(acks,[1])
                if stop == "unwatch":await client.unwatch({"subscriptionId":ID})
                elif stop == "inbox-close":inbox.close(ID)
                elif stop == "dispose":close_event_channel(peer)
                gate.set()
                for _ in range(5):await asyncio.sleep(0)
                if stop == "callback-error":
                    self.assertEqual(len(notices),1)
                    changed=dict(event(2),delivery="telemetry",kind="settings.changed",data={"revision":"r_"+"1"*32,"schemaVersion":1,"changedKeys":["fixture.enabled"],"cause":"update"})
                    self.assertTrue(inbox.accept(changed))
                    for _ in range(5):await asyncio.sleep(0)
                    self.assertEqual(acks,[1,2]);self.assertEqual(len(notices),1)
                    callback_gate.set()
                    for _ in range(5):await asyncio.sleep(0)
                    self.assertEqual(notices[1],{"type":"event","event":changed})
                else:self.assertEqual(notices,[])
            finally:
                gate.set();callback_gate.set();close_event_channel(peer)

    async def test_snapshot_callback_can_unwatch(self):
        from types import SimpleNamespace
        from kobrixa._events import bind_event_channel, close_event_channel, settings_event_client
        from kobrixa._settings import create_settings_client
        snapshot={"schemaVersion":1,"revision":None,"values":[]}
        class Peer:
            async def _request(self,method,params):
                if method == "settings/watch":return {"ok":True,"value":{"subscriptionId":ID,"sequence":0,"snapshot":snapshot}}
                if method == "settings/read":return {"ok":True,"value":snapshot}
                if method == "events/ack":return {"ok":True,"value":{}}
                if method == "events/unsubscribe":return {"ok":True,"value":{"removed":True}}
                raise AssertionError(method)
        peer=Peer();peer.devices=SimpleNamespace(inbox=None)
        bind_event_channel(peer,OWNER)
        notices=[]
        client=settings_event_client(peer,create_settings_client(peer._request))
        async def listener(notice):
            notices.append(notice)
            await client.unwatch({"subscriptionId":ID})
        try:
            await client.watch({"schemaVersion":1},listener)
            changed=dict(event(2),delivery="telemetry",kind="settings.changed",data={"revision":"r_"+"1"*32,"schemaVersion":1,"changedKeys":["fixture.enabled"],"cause":"update"})
            self.assertTrue(peer.devices.inbox.accept(changed))
            for _ in range(10):await asyncio.sleep(0)
            self.assertEqual(notices,[{"type":"snapshot","snapshot":snapshot}])
        finally:close_event_channel(peer)
