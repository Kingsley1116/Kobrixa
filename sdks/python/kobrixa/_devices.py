import copy
from ._connection_recovery import supported, request as recovery_request
import asyncio
from ._events import EventInbox

_UNAVAILABLE={'ok':False,'error':{'code':'PLUGIN_E_DEVICE_UNAVAILABLE','message':'Devices are unavailable before initialization or on this host.','detail':{'kind':'device','reason':'provider-disabled','dispatch':'not-sent','stopConfirmation':'not-required'}}}
class PluginBusinessError(Exception):
    def __init__(self,error):
        super().__init__(error['message']);self.code=error['code'];self.detail=error.get('detail')
def unwrap(result):
    if result['ok']:return result['value']
    raise PluginBusinessError(result['error'])
class Subscription:
    def __init__(self,devices,id,snapshot):self._devices=devices;self.subscription_id=id;self.snapshot=snapshot
    @property
    def last_sequence(self):return self._devices.inbox.last(self.subscription_id)
    async def close(self):
        result=await self._devices._send('events/unsubscribe',{'subscriptionId':self.subscription_id})
        if result['ok']:self._devices.inbox.close(self.subscription_id)
        return result
    async def __aenter__(self):return self
    async def __aexit__(self,*args):await self.close()
class _Methods:
    def __init__(self,devices,prefix,names):
        for name in names:
            async def call(params,method=prefix+name):return await devices._call(method,params)
            setattr(self,name,call)
class Devices:
    def __init__(self,request):
        self._request=request;self._version=None;self._negotiation=None
        self.inbox=None
        self._epoch=0;self._observers=set();self._cleanup_lock=asyncio.Lock()
        self.input_modes=_Methods(self,'devices/inputModes/',('query','set'))
        self.motion=_Methods(self,'devices/motion/',('prepare','start','query','stop'))
        self.connection_recovery=_Methods(self,'devices/connectionRecovery/',('read',))
        self.recording=_Methods(self,'devices/recording/',('reserve','query','read','release'))
        for name in ('context','list','discover','connect','disconnect','session','read'):
            async def call(params,method='devices/'+name):return await self._call(method,params)
            setattr(self,name,call)
    def retire(self,reachable=True):
        self._epoch+=1
        self._version=None
        self._negotiation=None
        for retire in list(self._observers):retire(reachable)
    def initialized(self,version):self._version=version
    async def _send(self,method,params):
        timeout=65 if method in ('devices/connect','devices/disconnect','devices/inputModes/set') else 15 if method in ('devices/read','devices/discover','devices/inputModes/query') else 5
        return await self._request(method,params,timeout=timeout)
    async def _ack(self,id,sequence):await self._send('events/ack',{'subscriptionId':id,'sequence':sequence})
    async def negotiate(self):
        if self._version is None or tuple(map(int,self._version.split('.')[:2]))<(1,5):return _UNAVAILABLE
        admitted_epoch=self._epoch
        if self._negotiation is None:
            async def attempt():
                successful=False
                try:
                    result=await self._send('devices/negotiate',{})
                    if admitted_epoch!=self._epoch:return _UNAVAILABLE
                    successful=result['ok']
                    return result
                finally:
                    if not successful and admitted_epoch==self._epoch:self._negotiation=None
            self._negotiation=asyncio.create_task(attempt())
        result=await asyncio.shield(self._negotiation)
        if result['ok'] and self.inbox is not None:self.inbox.enable()
        return result
    async def _call(self,method,params):
        params=copy.deepcopy(params)
        if recovery_request(method,params) and not supported(self._version):return _UNAVAILABLE
        status=await self.negotiate()
        return await self._send(method,params) if status['ok'] else status
    async def subscribe(self,params,listener):
        params=copy.deepcopy(params)
        if params.get('topic')=='connectionRecovery' and not supported(self._version):return _UNAVAILABLE
        status=await self.negotiate()
        if not status['ok']:return status
        if self.inbox is None:return _UNAVAILABLE
        recovery=params['topic']=='connectionRecovery'
        epoch=self._epoch;inbox=self.inbox
        def live():return epoch==self._epoch and self.inbox is inbox
        finish=inbox.begin_subscription(recovery)
        try:
            result=await self._send('devices/subscribe',params)
            if not result['ok']:return result
            subscription=Subscription(self,result['value']['subscriptionId'],result['value']['snapshot'])
            disposed=False;terminal=False;cleanup=None
            def close_host():
                nonlocal cleanup
                if cleanup is None:
                    async def unsubscribe():
                        async with self._cleanup_lock:
                            if self.inbox is not inbox:return _UNAVAILABLE
                            return await self._send('events/unsubscribe',{'subscriptionId':subscription.subscription_id})
                    cleanup=asyncio.create_task(unsubscribe())
                    def done(task):
                        nonlocal cleanup
                        failed=task.cancelled() or task.exception() is not None or not task.result()['ok']
                        if failed and cleanup is task:cleanup=None
                    cleanup.add_done_callback(done)
                return cleanup
            def retire(reachable=True):
                nonlocal disposed
                disposed=True
                inbox.close(subscription.subscription_id,cancel_running=False)
                self._observers.discard(retire)
                # A closed transport has no reachable host. Session retirement on
                # the same channel can still release the original opaque handle.
                if reachable and self.inbox is inbox:close_host()
            async def close():
                retire()
                return await asyncio.shield(close_host())
            def current():return not disposed and not terminal and live()
            def terminal_cleanup():
                nonlocal terminal
                terminal=True
                return close_host()
            async def notify_terminal(event):
                self._observers.discard(retire)
                if not disposed and live():
                    outcome=listener(event)
                    if hasattr(outcome,'__await__'):await outcome
            if recovery:
                subscription.close=close
                if not live():retire();return _UNAVAILABLE
                self._observers.add(retire)
            async def refresh():
                if recovery and not current():return
                topic=params['topic']
                if topic=='connectionRecovery':refreshed=await self.connection_recovery.read({})
                elif topic=='catalog':refreshed=await self.list({})
                elif topic in ('session','telemetry'):refreshed=await self.session({'sessionId':params['sessionId']})
                elif topic=='motion':refreshed=await self.motion.query({'operationId':params['operationId']})
                elif topic=='reservation':refreshed=await self.recording.query({'reservationId':params['reservationId']})
                else:refreshed=await self.context({'contextRef':params['contextRef']})
                if recovery and not (not disposed and not terminal and live()):return
                if refreshed['ok']:
                    value=refreshed['value']
                    if topic=='connectionRecovery' and (value['hostEpoch']!=subscription.snapshot['hostEpoch'] or value['revision']<subscription.snapshot['revision']):return
                    subscription.snapshot=value.get('operation',value.get('reservation',value))
            async def deliver(event):
                if recovery and not current():retire();return
                if params['topic']=='connectionRecovery' and event['kind']=='devices.connectionRecovery':
                    value=event['data']
                    if value['hostEpoch']!=subscription.snapshot['hostEpoch'] or value['revision']<subscription.snapshot['revision']:return
                    subscription.snapshot=copy.deepcopy(value)
                result=listener(event)
                if hasattr(result,'__await__'):await result
            inbox.open(subscription.subscription_id,deliver,refresh,on_terminal=notify_terminal if recovery else None,cleanup=terminal_cleanup if recovery else None)
            return {'ok':True,'value':subscription}
        finally:finish()
