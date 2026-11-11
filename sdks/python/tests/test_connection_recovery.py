import asyncio
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from kobrixa._plugin import Plugin, RpcError
from kobrixa._schema import Validator, SchemaError
from kobrixa._framing import Decoder
from kobrixa._connection_recovery import validate_snapshot
from kobrixa._devices import Devices
from kobrixa._events import EventInbox, bind_event_channel, close_event_channel

ID = "00000000-0000-4000-8000-000000000001"
SNAPSHOT = {"hostEpoch": ID, "revision": 1, "recovery": None}
NEGOTIATED = {"ok": True, "value": {"devicesContractVersion": 1, "eventVersion": 1, "capabilities": [], "requirementsSatisfied": True}}
OWNER = {"sourceKey": "builtin:test.recovery", "pluginId": "test.recovery", "generation": 1, "hostEpoch": ID, "processEpoch": ID}

class RecoverySchemaTests(unittest.TestCase):
    def test_shared_semantics_and_strict_legacy_schema(self):
        validator = Validator.bundled()
        cases = json.loads((Path(__file__).resolve().parents[3] / "packages/plugin-protocol/test-fixtures/connection-recovery-v180/cases.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case['id']):
                def check():
                    validator.validate("connection-recovery-snapshot", case['snapshot'])
                    validate_snapshot(case['snapshot'])
                if case['valid']: check()
                else:
                    with self.assertRaises((ValueError, SchemaError, UnicodeError)): check()
        with self.assertRaises(SchemaError): validator.validate("devices/subscribe.v170.params", {"topic": "connectionRecovery"})
        validator.validate("devices/subscribe.params", {"topic": "connectionRecovery"})

class RecoveryPortTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved=sys.stdout
        try: self.plugin=Plugin()
        finally: sys.stdout=saved
        self.plugin._loop=asyncio.get_running_loop()
        self.plugin._output=io.BytesIO()
    def messages(self):
        return [json.loads(s) for s in Decoder().push(self.plugin._output.getvalue())]
    async def handle(self, method, params):
        await self.plugin._handle({'jsonrpc':'2.0','id':99,'method':method,'params':params})
        return self.messages()[-1]
    async def initialize(self, version='1.8.0'):
        return await self.handle('initialize',{'apiVersion':version,'pluginId':'test.recovery','locale':'en','grantedPermissions':[]})
    async def reply(self,task,result):
        await asyncio.sleep(0)
        message=self.messages()[-1]
        self.plugin._receive(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}))
        return await task
    async def negotiate(self):
        task=asyncio.create_task(self.plugin._request('devices/negotiate',{},timeout=5))
        return await self.reply(task,NEGOTIATED)
    async def test_effective_initialize_and_independent_device_readiness(self):
        for version in ('1.5.0','1.6.0','1.7.0'):
            await self.initialize(version);await self.negotiate()
            with self.assertRaises(RpcError):await self.plugin._request('devices/connectionRecovery/read',{})
        with patch('kobrixa._plugin.API_VERSION','1.7.0'):
            await self.initialize();await self.negotiate()
            with self.assertRaises(RpcError):await self.plugin._request('devices/connectionRecovery/read',{})
        await self.initialize()
        with self.assertRaises(RpcError):await self.plugin._request('devices/connectionRecovery/read',{})
        await self.negotiate()
        self.assertIsNone(self.plugin._ui_version)
        task=asyncio.create_task(self.plugin._request('devices/connectionRecovery/read',{}))
        self.assertEqual(await self.reply(task,{'ok':True,'value':SNAPSHOT}),{'ok':True,'value':SNAPSHOT})
    async def test_result_and_event_correlation_before_early_delivery(self):
        await self.initialize();await self.negotiate()
        task=asyncio.create_task(self.plugin._request('devices/subscribe',{'topic':'connectionRecovery'}))
        with self.assertRaises((ValueError,SchemaError)):
            await self.reply(task,{'ok':True,'value':{'subscriptionId':ID,'sequence':0,'snapshot':{'revision':1,'providers':[],'sessions':[]}}})
        task=asyncio.create_task(self.plugin._request('devices/subscribe',{'topic':'connectionRecovery'}))
        await self.reply(task,{'ok':True,'value':{'subscriptionId':ID,'sequence':0,'snapshot':SNAPSHOT}})
        event={'version':1,'subscriptionId':ID,'owner':OWNER,'sequence':1,'delivery':'control','kind':'devices.connectionRecovery','data':SNAPSHOT}
        self.plugin._validate_ui('events/deliver','params',event)
        with self.assertRaises(SchemaError):self.plugin._validate_ui('events/deliver','params',{**event,'subscriptionId':ID[:-1]+'2'})
        with self.assertRaises(SchemaError):self.plugin._validate_ui('events/deliver','params',{**event,'kind':'devices.catalog','data':{'revision':1,'providers':[],'sessions':[]}})
        task=asyncio.create_task(self.plugin._request('events/unsubscribe',{'subscriptionId':ID}))
        await self.reply(task,{'ok':True,'value':{'removed':True}})
        with self.assertRaises(SchemaError):self.plugin._validate_ui('events/deliver','params',event)
    async def test_cancel_late_reply_and_shutdown(self):
        await self.initialize();await self.negotiate()
        task=asyncio.create_task(self.plugin._request('devices/connectionRecovery/read',{},timeout=5));await asyncio.sleep(0)
        original=self.messages()[-1]
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertEqual(self.messages()[-1]['method'],'$/cancelRequest')
        self.plugin._receive(json.dumps({'jsonrpc':'2.0','id':original['id'],'result':{'ok':True,'value':SNAPSHOT}}))
        self.assertEqual(self.plugin._device_inputs,{})
        await self.handle('shutdown',{})
        with self.assertRaises(RpcError):await self.plugin._request('devices/connectionRecovery/read',{})
    async def test_settled_old_negotiation_cannot_authorize_new_initialize(self):
        await self.initialize()
        task=asyncio.create_task(self.plugin._request('devices/negotiate',{}));await asyncio.sleep(0)
        original=self.messages()[-1]
        self.plugin._receive(json.dumps({'jsonrpc':'2.0','id':original['id'],'result':NEGOTIATED}))
        # Reinitialize after receiving the reply, before the original coroutine resumes.
        await self.initialize()
        with self.assertRaises(RpcError): await task
        self.assertFalse(self.plugin._recovery_ready)
        await self.negotiate()
        self.plugin._receive(json.dumps({'jsonrpc':'2.0','method':'exit','params':{}}))
        self.assertFalse(self.plugin._recovery_ready)

    async def test_failed_initialize_does_not_retain_candidate(self):
        await self.initialize();await self.negotiate()
        result=await self.handle('initialize',{'apiVersion':'bad'})
        self.assertIn('error',result)
        self.assertFalse(self.plugin._recovery_candidate)
        with self.assertRaises(RpcError):await self.plugin._request('devices/connectionRecovery/read',{})
    async def test_facade_one_call_five_seconds_and_old_version_no_send(self):
        calls=[]
        async def request(method,params,timeout):
            calls.append((method,params,timeout))
            return NEGOTIATED if method=='devices/negotiate' else {'ok':True,'value':SNAPSHOT}
        devices=Devices(request)
        devices.initialized('1.7.0')
        self.assertFalse((await devices.connection_recovery.read({}))['ok']);self.assertEqual(calls,[])
        devices.initialized('1.8.0')
        self.assertTrue((await devices.connection_recovery.read({}))['ok'])
        self.assertEqual(calls,[('devices/negotiate',{},5),('devices/connectionRecovery/read',{},5)])

    async def test_facade_common_event_gap_catchup_and_monotonic_projection(self):
        calls=[]
        async def request(method,params,timeout):
            calls.append(method)
            if method=='devices/negotiate': return NEGOTIATED
            if method=='devices/subscribe': return {'ok':True,'value':{'subscriptionId':ID,'sequence':0,'snapshot':SNAPSHOT}}
            if method=='devices/connectionRecovery/read': return {'ok':True,'value':{**SNAPSHOT,'revision':4}}
            raise AssertionError('Unexpected authority or connection call')
        async def ack(*args): pass
        devices=Devices(request);devices.initialized('1.8.0');devices.inbox=EventInbox(ack,OWNER)
        seen=[]
        subscription=(await devices.subscribe({'topic':'connectionRecovery'},seen.append))['value']
        async def emit(sequence,revision):
            self.assertTrue(devices.inbox.accept({'version':1,'subscriptionId':ID,'owner':OWNER,'sequence':sequence,'delivery':'control','kind':'devices.connectionRecovery','data':{**SNAPSHOT,'revision':revision}}))
            for _ in range(5): await asyncio.sleep(0)
        await emit(2,2)
        self.assertEqual(subscription.snapshot['revision'],4);self.assertEqual(seen,[])
        await emit(3,5);await emit(5,6)
        self.assertEqual(subscription.snapshot['revision'],6);self.assertEqual(len(seen),2)
        self.assertEqual(calls.count('devices/connectionRecovery/read'),2)

    async def test_recovery_terminal_closes_carrier_and_secondary_without_refresh(self):
        for with_ui in (False,True):
            calls=[];sequence=0
            async def request(method,params,timeout):
                nonlocal sequence
                calls.append(method)
                if method=='devices/negotiate':return NEGOTIATED
                if method=='devices/subscribe':
                    sequence+=1
                    return {'ok':True,'value':{'subscriptionId':ID[:-1]+str(sequence),'sequence':0,'snapshot':SNAPSHOT}}
                if method=='devices/connectionRecovery/read':return {'ok':True,'value':SNAPSHOT}
                if method=='events/unsubscribe':return {'ok':True,'value':{'removed':True}}
                raise AssertionError(method)
            async def ack(*args):pass
            devices=Devices(request);devices.initialized('1.8.0');devices.inbox=EventInbox(ack,OWNER)
            if with_ui:devices.inbox._terminal_handler=lambda event:None
            first=[];second=[]
            a=(await devices.subscribe({'topic':'connectionRecovery'},first.append))['value']
            b=(await devices.subscribe({'topic':'connectionRecovery'},second.append))['value']
            terminal={'version':1,'owner':OWNER,'subscriptionId':a.subscription_id,'sequence':1,'delivery':'control','kind':'events.resyncRequired','data':{'reason':'overflow','affected':[a.subscription_id,b.subscription_id]}}
            self.assertTrue(devices.inbox.accept(terminal))
            for _ in range(8):await asyncio.sleep(0)
            self.assertEqual(len(first),1);self.assertEqual(len(second),1)
            self.assertNotIn('devices/connectionRecovery/read',calls)
            self.assertNotIn(a.subscription_id,devices.inbox._slots);self.assertNotIn(b.subscription_id,devices.inbox._slots)
            self.assertFalse(devices.inbox.accept({**terminal,'sequence':2,'kind':'devices.connectionRecovery','data':SNAPSHOT}))


    async def test_pure_terminal_waits_for_catchup_and_drops_queued_event(self):
        acks=[]
        async def ack(*args):acks.append(args)
        inbox=EventInbox(ack,OWNER);inbox.enable()
        release=asyncio.Event();started=asyncio.Event();seen=[];terminal=[]
        async def refresh():
            started.set()
            await release.wait()
        inbox.open(ID,seen.append,refresh,on_terminal=terminal.append)
        event={'version':1,'owner':OWNER,'subscriptionId':ID,'sequence':2,'delivery':'control','kind':'devices.connectionRecovery','data':SNAPSHOT}
        self.assertTrue(inbox.accept(event))
        await started.wait()
        self.assertTrue(inbox.accept({**event,'sequence':3,'kind':'events.resyncRequired','data':{'reason':'overflow','affected':[ID]}}))
        for _ in range(8):await asyncio.sleep(0)
        self.assertEqual(len(acks),2);self.assertEqual(terminal,[])
        release.set()
        for _ in range(12):await asyncio.sleep(0)
        self.assertEqual(seen,[]);self.assertEqual(len(terminal),1)
        self.assertNotIn(ID,inbox._slots)

    async def test_pure_terminal_before_adoption_closes_late_slot(self):
        async def ack(*args):pass
        inbox=EventInbox(ack,OWNER);inbox.enable()
        finish=inbox.begin_subscription(True)
        event={'version':1,'owner':OWNER,'subscriptionId':ID,'sequence':1,'delivery':'control','kind':'events.resyncRequired','data':{'reason':'overflow','affected':[ID]}}
        self.assertTrue(inbox.accept(event))
        for _ in range(5):await asyncio.sleep(0)
        seen=[];terminal=[];reads=[]
        async def refresh():reads.append(True)
        inbox.open(ID,seen.append,refresh,on_terminal=terminal.append)
        finish()
        for _ in range(12):await asyncio.sleep(0)
        self.assertEqual(len(terminal),1);self.assertEqual(seen,[]);self.assertEqual(reads,[])
        self.assertNotIn(ID,inbox._slots)
        self.assertFalse(inbox.accept({**event,'sequence':2}))

    async def run_retirement(self, mode):
        await self.initialize()
        original=self.plugin._send
        def send(message):
            original(message)
            method=message.get('method')
            if method=='devices/negotiate': result=NEGOTIATED
            elif method=='devices/subscribe': result={'ok':True,'value':{'subscriptionId':ID,'sequence':0,'snapshot':SNAPSHOT}}
            elif method=='events/ack': result={'ok':True,'value':{'acknowledged':message['params']['sequence']}}
            else:return
            asyncio.get_running_loop().call_soon(self.plugin._receive,json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}))
        self.plugin._send=send
        bind_event_channel(self.plugin,OWNER)
        release=asyncio.Event(); started=asyncio.Event(); seen=[]
        async def listener(e):
            seen.append(e['data']['revision'])
            if len(seen)==1:
                started.set(); await release.wait()
        await self.plugin.devices.subscribe({'topic':'connectionRecovery'},listener)
        def emit(n):
            self.plugin._receive(json.dumps({'jsonrpc':'2.0','method':'events/deliver','params':{'version':1,'owner':OWNER,'subscriptionId':ID,'sequence':n,'delivery':'control','kind':'devices.connectionRecovery','data':{**SNAPSHOT,'revision':n+1}}}))
        try:
            emit(1); await started.wait(); emit(2)
            if mode=='shutdown':await self.handle('shutdown',{})
            else:await self.initialize('1.8.0' if mode=='reinitialize' else '1.7.0')
            self.assertFalse(self.plugin._recovery_ready)
            if mode=='reinitialize':
                await self.plugin.devices.negotiate()
                self.assertTrue(self.plugin._recovery_ready)
            release.set()
            for _ in range(8):await asyncio.sleep(0)
            self.assertEqual(seen,[2])
        finally:close_event_channel(self.plugin)
    async def test_queued_shutdown(self):await self.run_retirement('shutdown')
    async def test_queued_downgrade(self):await self.run_retirement('downgrade')

    async def test_queued_same_version_reinitialize(self):await self.run_retirement('reinitialize')

    async def test_terminal_cleanup_precedes_notice_and_explicit_close_joins(self):
        release=asyncio.Event();entered=asyncio.Event();calls=[];seen=[]
        async def request(method,params,timeout):
            calls.append(method)
            if method=='devices/negotiate':return NEGOTIATED
            if method=='devices/subscribe':return {'ok':True,'value':{'subscriptionId':ID,'sequence':0,'snapshot':SNAPSHOT}}
            if method=='events/unsubscribe':
                entered.set();await release.wait()
                return {'ok':True,'value':{'removed':True}}
            raise AssertionError(method)
        async def ack(*args):pass
        devices=Devices(request);devices.initialized('1.8.0');devices.inbox=EventInbox(ack,OWNER)
        sub=(await devices.subscribe({'topic':'connectionRecovery'},seen.append))['value']
        devices.inbox.accept({'version':1,'owner':OWNER,'subscriptionId':ID,'sequence':1,'delivery':'control','kind':'events.resyncRequired','data':{'reason':'overflow','affected':[ID]}})
        await entered.wait()
        self.assertEqual(seen,[])
        close=asyncio.create_task(sub.close());await asyncio.sleep(0)
        release.set();await close
        for _ in range(8):await asyncio.sleep(0)
        self.assertEqual(seen,[])
        self.assertEqual(calls.count('events/unsubscribe'),1)
        self.assertEqual(calls.count('devices/subscribe'),1)
