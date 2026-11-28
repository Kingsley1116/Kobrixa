import asyncio
import copy
import io
import json
import sys
import unittest
from types import SimpleNamespace
from kobrixa._events import EventInbox, bind_event_channel, close_event_channel, ui_event_client_port
from kobrixa._ui import Ui
from kobrixa._plugin import Plugin
from kobrixa._framing import Decoder


def ident(n): return f'00000000-0000-4000-8000-{n:012d}'
OWNER = {'sourceKey':'builtin:test.ui','pluginId':'test.ui','generation':1,'hostEpoch':ident(1),'processEpoch':ident(2)}
SNAPSHOT = {'instances':[],'states':[],'locale':'en','theme':'light'}
def terminal(id, affected=None, sequence=1):
    return {'version':1,'owner':copy.deepcopy(OWNER),'subscriptionId':id,'sequence':sequence,
            'delivery':'control','kind':'events.resyncRequired','data':{'reason':'overflow','affected':affected or [id]}}
async def ticks():
    for _ in range(20): await asyncio.sleep(0)

class Peer:
    def __init__(self):
        self.devices=SimpleNamespace(inbox=None);self.calls=[];self.next=100;self._ui_epoch=1
        self.gate=None
    async def _request(self, method, params):
        self.calls.append((method,copy.deepcopy(params)))
        if method=='ui/subscribe':
            id=ident(self.next);self.next+=1
            if self.gate is not None: await self.gate.wait()
            return {'ok':True,'value':{'subscriptionId':id,'sequence':0,'snapshot':copy.deepcopy(SNAPSHOT)}}
        if method=='events/ack': return {'ok':True,'value':{'acknowledged':params['sequence']}}
        if method=='events/unsubscribe': return {'ok':True,'value':{'removed':False}}
        if method=='ui/snapshot': return {'ok':True,'value':{'sequence':3,'snapshot':copy.deepcopy(SNAPSHOT)}}
        raise AssertionError(method)

class TerminalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.peer=Peer();bind_event_channel(self.peer,OWNER)
        self.ui=Ui(self.peer._request,ui_event_client_port(self.peer));self.ui.mark_ready()
    async def asyncTearDown(self):
        self.ui.retire();close_event_channel(self.peer);await ticks()
    async def subscribe(self, callback=lambda e:None):
        result=await self.ui.subscribe(['environment'],callback)
        return result['value']['subscriptionId']

    async def test_slow_throw_cleanup_raw_ids_and_lifetime(self):
        for mode in ('slow','throw'):
            notices=[];gate=asyncio.Event()
            async def callback(notice):
                notices.append(notice);await notice.cleanup
                if mode=='throw': raise ValueError('consumer failure')
                await gate.wait()
            self.ui.on_resync_required(callback)
            old=await self.subscribe();self.assertTrue(self.peer.devices.inbox.accept(terminal(old)))
            await ticks();self.assertEqual(len(notices),1)
            methods=[m for m,_ in self.peer.calls]
            self.assertLess(methods.index('events/ack'),methods.index('events/unsubscribe'))
            self.assertNotIn('ui/snapshot',methods);self.assertNotIn(old,self.peer.devices.inbox._slots)
            fresh=await self.subscribe();self.assertNotEqual(fresh,old)
            await self.ui.unsubscribe(old);self.assertFalse(notices[0].subscriptions[0].is_current())
            self.assertIn(fresh,self.peer.devices.inbox._slots);gate.set();await ticks()

    async def test_cross_domain_carrier_and_serial_device_callbacks(self):
        seen=[];gate=asyncio.Event();old=await self.subscribe();device=ident(300)
        self.ui.on_resync_required(lambda n:seen.append('ui-terminal'))
        async def listener(event):
            seen.append(event['kind'])
            if event['kind']=='devices.catalog': await gate.wait()
        async def refresh(): seen.append('query')
        inbox=self.peer.devices.inbox;inbox.open(device,listener,refresh)
        event=terminal(device);event.update(kind='devices.catalog',data={'revision':1,'providers':[],'sessions':[]})
        inbox.accept(event);await ticks();inbox.accept(terminal(device,[device,old],2));await ticks()
        self.assertIn('ui-terminal',seen);self.assertNotIn('query',seen)
        gate.set();await ticks();self.assertEqual(seen[-2:],['query','events.resyncRequired'])

    async def test_early_adoption_private_params_and_retirement(self):
        notices=[];self.ui.on_resync_required(notices.append);self.peer.gate=asyncio.Event()
        topics=['environment'];pending=asyncio.create_task(self.ui.subscribe(topics,lambda e:None));await asyncio.sleep(0)
        topics[0]='instances';self.peer.devices.inbox.accept(terminal(ident(100)));await ticks()
        self.peer.gate.set();await pending;await ticks()
        self.assertEqual(notices[0].subscriptions[0].params,{'topics':['environment']})
        self.assertNotIn(ident(100),self.peer.devices.inbox._slots)
        self.assertEqual(self.peer.devices.inbox._early_terminal,{})
        self.assertEqual(self.peer.devices.inbox._terminal_jobs,[])

    async def test_queued_retire_detach_unsubscribe(self):
        for action in ('retire','detach','unsubscribe'):
            seen=[];detach=self.ui.on_resync_required(seen.append);old=await self.subscribe()
            self.peer.devices.inbox.accept(terminal(old))
            if action=='retire': self.ui.retire();self.ui.mark_ready()
            elif action=='detach': detach()
            else: await self.ui.unsubscribe(old)
            await ticks();self.assertEqual(seen,[])

    async def test_wrong_owners_and_ordinary_gap(self):
        seen=[];notices=[];self.ui.on_resync_required(notices.append);old=await self.subscribe(seen.append)
        for field in OWNER:
            event=terminal(old);event['owner'][field]=2 if field=='generation' else 'builtin:other.ui' if field=='sourceKey' else 'other.ui' if field=='pluginId' else ident(999)
            self.assertFalse(self.peer.devices.inbox.accept(event))
        self.assertEqual([m for m,_ in self.peer.calls],['ui/subscribe'])
        event=terminal(old,sequence=2);event.update(kind='ui.environment',data={'locale':'en','theme':'dark'})
        self.peer.devices.inbox.accept(event);await ticks();self.assertEqual(seen,[]);self.assertEqual(notices,[])
        event['sequence']=4;self.peer.devices.inbox.accept(event);await ticks();self.assertEqual(len(seen),1)

    async def test_controls_early_affected_budgets(self):
        ack=[];gate=asyncio.Event()
        async def acknowledge(id,sequence): ack.append((id,sequence))
        inbox=EventInbox(acknowledge,OWNER);inbox.enable();inbox._terminal_handler=lambda event:gate.wait
        finish=inbox.begin_subscription()
        for n in range(8): self.assertTrue(inbox.accept(terminal(ident(400+n))))
        self.assertFalse(inbox.accept(terminal(ident(410))));await ticks();self.assertEqual(len(ack),8)
        finish();gate.set();await ticks()
        finish=inbox.begin_subscription()
        self.assertTrue(inbox.accept(terminal(ident(500),[ident(500+n) for n in range(32)])))
        self.assertFalse(inbox.accept(terminal(ident(600))));finish();await ticks()

    async def test_early_adoption_bypasses_hung_device_and_explicit_cancel(self):
        inbox=self.peer.devices.inbox;device=ident(800);gate=asyncio.Event();seen=[]
        async def refresh(): pass
        inbox.enable();inbox.open(device,lambda event:gate.wait(),refresh)
        event=terminal(device);event.update(kind='devices.catalog',data={'revision':1,'providers':[],'sessions':[]})
        inbox.accept(event);await ticks()
        self.ui.on_resync_required(seen.append);self.peer.gate=asyncio.Event()
        task=asyncio.create_task(self.subscribe());await asyncio.sleep(0)
        inbox.accept(terminal(device,[device,ident(100)],2));await ticks()
        self.peer.gate.set();await task;await ticks();self.assertEqual(len(seen),1)
        gate.set();await ticks()
        self.peer.gate=asyncio.Event();task=asyncio.create_task(self.subscribe());await asyncio.sleep(0)
        inbox.accept(terminal(ident(101)));await self.ui.unsubscribe(ident(101))
        self.peer.gate.set()
        with self.assertRaisesRegex(RuntimeError,'cancelled'): await task
        await ticks();self.assertEqual(len(seen),1)

    async def test_32_cleanup_and_callback_cancellation_do_not_cancel_host_cleanup(self):
        ids=[await self.subscribe() for _ in range(32)];seen=[];gate=asyncio.Event();cleanup_gate=asyncio.Event()
        original=self.peer._request
        async def request(method,params):
            if method=='events/unsubscribe': await cleanup_gate.wait()
            return await original(method,params)
        self.ui._request=request
        async def callback(notice):
            seen.append(notice)
            await notice.cleanup
            await gate.wait()
        self.ui.on_resync_required(callback)
        self.peer.devices.inbox.accept(terminal(ids[0],ids));await ticks()
        self.assertEqual(len(self.ui._cleanup),32);self.assertEqual(len(self.peer.devices.inbox._slots),0)
        # Cancel the consumer-side await; independent SDK cleanup tasks must survive.
        async def waiter(): await seen[0].cleanup
        task=asyncio.create_task(waiter());await asyncio.sleep(0);task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(all(not task.cancelled() for task in self.ui._cleanup))
        cleanup_gate.set();self.assertEqual(len(await seen[0].cleanup),32);await ticks()
        fresh=await self.subscribe();self.assertNotIn(fresh,ids)
        self.ui.on_resync_required(lambda notice:None)
        self.assertTrue(all(not item.is_current() for item in seen[0].subscriptions))
        gate.set();await ticks()

    async def test_actual_settings_adapter_keeps_snapshot_notice(self):
        from kobrixa._events import settings_event_client
        from kobrixa._settings import create_settings_client
        old=await self.subscribe();ui_seen=[];settings_seen=[];self.ui.on_resync_required(ui_seen.append)
        original=self.peer._request;settings_id=ident(900);snapshot={'schemaVersion':1,'revision':None,'values':[]}
        async def request(method,params):
            if method=='settings/watch': return {'ok':True,'value':{'subscriptionId':settings_id,'sequence':0,'snapshot':snapshot}}
            if method=='settings/read': return {'ok':True,'value':snapshot}
            return await original(method,params)
        client=settings_event_client(self.peer,create_settings_client(request))
        await client.watch({'schemaVersion':1},settings_seen.append)
        self.peer.devices.inbox.accept(terminal(settings_id,[settings_id,old]));await ticks()
        self.assertEqual(len(ui_seen),1);self.assertEqual(settings_seen,[{'type':'snapshot','snapshot':snapshot}])
        await client.unwatch({'subscriptionId':settings_id})

    async def test_early_settings_carrier_preserves_its_snapshot_notice(self):
        from kobrixa._events import settings_event_client
        from kobrixa._settings import create_settings_client
        old=await self.subscribe();ui_seen=[];settings_seen=[];self.ui.on_resync_required(ui_seen.append)
        original=self.peer._request;settings_id=ident(910);snapshot={'schemaVersion':1,'revision':None,'values':[]};gate=asyncio.Event()
        async def request(method,params):
            if method=='settings/watch':
                await gate.wait()
                return {'ok':True,'value':{'subscriptionId':settings_id,'sequence':0,'snapshot':snapshot}}
            if method=='settings/read': return {'ok':True,'value':snapshot}
            return await original(method,params)
        client=settings_event_client(self.peer,create_settings_client(request))
        task=asyncio.create_task(client.watch({'schemaVersion':1},settings_seen.append));await asyncio.sleep(0)
        self.peer.devices.inbox.accept(terminal(settings_id,[settings_id,old]));await ticks()
        self.assertEqual(len(ui_seen),1);gate.set();await task;await ticks()
        self.assertEqual(settings_seen,[{'type':'snapshot','snapshot':snapshot}])
        await client.unwatch({'subscriptionId':settings_id})

    async def test_host_quota_result_and_local_adoption_failure_cleanup(self):
        ids=[await self.subscribe() for _ in range(32)]
        quota={'ok':False,'error':{'code':'PLUGIN_E_RESOURCE_LIMIT','message':'Subscription limit',
               'detail':{'kind':'resource','reason':'quota','resource':'subscription','limit':32}}}
        original=self.ui._request
        async def request(method,params):
            if method=='ui/subscribe': return quota
            return await original(method,params)
        self.ui._request=request
        self.assertEqual(await self.ui.subscribe(['environment'],lambda event:None),quota)
        self.ui._request=original
        with self.assertRaisesRegex(ValueError,'Subscription queue full'): await self.subscribe()
        await ticks();self.assertEqual(len(self.ui._records),32)
        await self.ui.unsubscribe(ids[0]);self.assertIsInstance(await self.subscribe(),str)

class ActualPeerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved=sys.stdout
        try: self.plugin=Plugin()
        finally: sys.stdout=saved
        self.plugin._loop=asyncio.get_running_loop();self.plugin._output=io.BytesIO()
        bind_event_channel(self.plugin,OWNER)
        for method,params in [('initialize',{'apiVersion':'1.8.0','pluginId':'test.ui','locale':'en','grantedPermissions':[]}),
                              ('ui/negotiate',{'commandEnvelopeVersions':[1],'uiResourceVersions':[1]}),('ui/ready',{})]:
            await self.plugin._handle({'jsonrpc':'2.0','id':99,'method':method,'params':params})
    async def asyncTearDown(self):
        self.plugin.ui.retire();close_event_channel(self.plugin);await ticks()
    def messages(self): return [json.loads(s) for s in Decoder().push(self.plugin._output.getvalue())]
    def reply(self, request, result): self.plugin._receive(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}))
    async def test_actual_peer_terminal_and_resolved_reply_retirement(self):
        seen=[];self.plugin.ui.on_resync_required(seen.append)
        task=asyncio.create_task(self.plugin.ui.subscribe(['environment'],lambda e:self.fail('UI union')))
        await asyncio.sleep(0);request=self.messages()[-1]
        event=terminal(ident(700));self.plugin._receive(json.dumps({'jsonrpc':'2.0','method':'events/deliver','params':event}))
        await ticks()
        self.reply(request,{'ok':True,'value':{'subscriptionId':ident(700),'sequence':0,'snapshot':SNAPSHOT}})
        await task;await ticks();self.assertEqual(len(seen),1)
        methods=[m['method'] for m in self.messages() if 'method' in m]
        self.assertEqual(methods[-3:],['ui/subscribe','events/ack','events/unsubscribe'])
        for m in self.messages():
            if m.get('method')=='events/ack': self.reply(m,{'ok':True,'value':{'acknowledged':1}})
            if m.get('method')=='events/unsubscribe': self.reply(m,{'ok':True,'value':{'removed':False}})
        await seen[0].cleanup
        task=asyncio.create_task(self.plugin.ui.subscribe(['environment'],lambda e:None));await asyncio.sleep(0)
        request=self.messages()[-1]
        self.reply(request,{'ok':True,'value':{'subscriptionId':ident(701),'sequence':0,'snapshot':SNAPSHOT}})
        self.plugin.ui.retire();self.plugin.ui.mark_ready()
        with self.assertRaisesRegex(RuntimeError,'retired'): await task
        self.assertNotIn(ident(701),self.plugin.devices.inbox._slots)
