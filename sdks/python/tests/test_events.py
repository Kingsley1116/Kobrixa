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
