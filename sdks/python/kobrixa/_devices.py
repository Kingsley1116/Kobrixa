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
        self.input_modes=_Methods(self,'devices/inputModes/',('query','set'))
        self.motion=_Methods(self,'devices/motion/',('prepare','start','query','stop'))
        self.recording=_Methods(self,'devices/recording/',('reserve','query','read','release'))
        for name in ('context','list','discover','connect','disconnect','session','read'):
            async def call(params,method='devices/'+name):return await self._call(method,params)
            setattr(self,name,call)
    def initialized(self,version):self._version=version
    async def _send(self,method,params):
        timeout=65 if method in ('devices/connect','devices/disconnect','devices/inputModes/set') else 15 if method in ('devices/read','devices/discover','devices/inputModes/query') else 5
        return await self._request(method,params,timeout=timeout)
    async def _ack(self,id,sequence):await self._send('events/ack',{'subscriptionId':id,'sequence':sequence})
    async def negotiate(self):
        if self._version is None or tuple(map(int,self._version.split('.')[:2]))<(1,5):return _UNAVAILABLE
        if self._negotiation is None:
            async def attempt():
                successful=False
                try:
                    result=await self._send('devices/negotiate',{})
                    successful=result['ok']
                    return result
                finally:
                    if not successful:self._negotiation=None
            self._negotiation=asyncio.create_task(attempt())
        result=await asyncio.shield(self._negotiation)
        if result['ok'] and self.inbox is not None:self.inbox.enable()
        return result
    async def _call(self,method,params):
        status=await self.negotiate()
        return await self._send(method,params) if status['ok'] else status
    async def subscribe(self,params,listener):
        status=await self.negotiate()
        if not status['ok']:return status
        if self.inbox is None:return _UNAVAILABLE
        finish=self.inbox.begin_subscription()
        try:
            result=await self._send('devices/subscribe',params)
            if not result['ok']:return result
            subscription=Subscription(self,result['value']['subscriptionId'],result['value']['snapshot'])
            async def refresh():
                topic=params['topic']
                if topic=='catalog':current=await self.list({})
                elif topic in ('session','telemetry'):current=await self.session({'sessionId':params['sessionId']})
                elif topic=='motion':current=await self.motion.query({'operationId':params['operationId']})
                elif topic=='reservation':current=await self.recording.query({'reservationId':params['reservationId']})
                else:current=await self.context({'contextRef':params['contextRef']})
                if current['ok']:
                    value=current['value'];subscription.snapshot=value.get('operation',value.get('reservation',value))
            self.inbox.open(subscription.subscription_id,listener,refresh)
            return {'ok':True,'value':subscription}
        finally:finish()
