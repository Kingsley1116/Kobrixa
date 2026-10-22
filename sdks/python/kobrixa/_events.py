import asyncio
import inspect
import json
from ._schema import Validator, SchemaError

def _size(value): return len(json.dumps(value,ensure_ascii=True,separators=(',',':')).encode('utf-8'))
class EventInbox:
    def __init__(self,ack,owner):
        self._owner=dict(owner)
        self._acks=set()
        self._ack=ack;self._enabled=False;self._pending=0;self._early=[];self._slots={};self._validator=Validator.bundled()
    def enable(self): self._enabled=True
    def begin_subscription(self):
        self._pending+=1
        def finish():
            self._pending-=1
            if not self._pending: self._early=[]
        return finish
    def open(self,id,listener,resync):
        if len(self._slots)>=32: raise ValueError('Subscription queue full')
        self._slots[id]={'last':0,'owner':None,'queue':[],'bytes':0,'controls':0,'task':None,'listener':listener,'resync':resync}
        early,self._early=self._early,[]
        for event in early:
            if event['subscriptionId']==id: self.accept(event)
            else: self._early.append(event)
    def last(self,id): return self._slots.get(id,{}).get('last',0)
    def close(self,id):
        slot=self._slots.pop(id,None)
        if slot and slot['task']: slot['task'].cancel()
    def accept(self,event):
        if not self._enabled: return False
        try: self._validator.validate('events/deliver.params',event)
        except (SchemaError,ValueError): return False
        if event['owner']!=self._owner: return False
        slot=self._slots.get(event['subscriptionId']);size=_size(event)
        if slot is None:
            if not self._pending or len(self._early)>=8 or sum(map(_size,self._early))+size>262144: return False
            self._early.append(event);return True
        owner=json.dumps(event['owner'],sort_keys=True)
        if slot['owner'] is not None and slot['owner']!=owner or event['sequence']<=slot['last']: return False
        if (sum(s['controls'] for s in self._slots.values())>=8 if event['delivery']=='control' else sum(s['bytes'] for s in self._slots.values())+sum(map(_size,self._early))+size>262144): return False
        gap=event['sequence']!=slot['last']+1
        slot['owner']=owner;slot['last']=event['sequence'];slot['queue'].append((event,gap));slot['bytes']+=size
        if event['delivery']=='control':slot['controls']+=1
        task=asyncio.create_task(self._ack_safe(event['subscriptionId'],event['sequence']))
        self._acks.add(task)
        task.add_done_callback(self._acks.discard)
        if slot['task'] is None:slot['task']=asyncio.create_task(self._pump(slot))
        return True
    async def _ack_safe(self,id,sequence):
        try: await self._ack(id,sequence)
        except Exception: pass
    async def _pump(self,slot):
        try:
            while slot['queue']:
                event,gap=slot['queue'][0]
                try:
                    if gap or event['kind']=='events.resyncRequired':await slot['resync']()
                    result=slot['listener'](event)
                    if inspect.isawaitable(result):await result
                except Exception: pass
                slot['queue'].pop(0);slot['bytes']-=_size(event)
                if event['delivery']=='control':slot['controls']-=1
        finally:slot['task']=None
import weakref
_BOUND = weakref.WeakKeyDictionary()
_EVER_BOUND = weakref.WeakSet()
def bind_event_channel(peer, owner) -> None:
    if peer in _EVER_BOUND or getattr(peer, '_stopping', False): raise ValueError('Event channel already bound')
    validator = Validator.bundled()
    validator.validate('resourceOwner', owner)
    async def ack(subscription_id, sequence):
        await peer._request('events/ack', {'subscriptionId':subscription_id,'sequence':sequence})
    inbox = EventInbox(ack, owner)
    _EVER_BOUND.add(peer)
    _BOUND[peer] = inbox
    peer.devices.inbox = inbox

def close_event_channel(peer):
    inbox = _BOUND.pop(peer, None)
    if inbox is not None:
        inbox._enabled = False
        for id in list(inbox._slots): inbox.close(id)
        inbox._early.clear()
        for task in list(inbox._acks): task.cancel()
        inbox._acks.clear()
        peer.devices.inbox = None

def ui_event_client_port(peer):
    raise NotImplementedError("UI event client is unavailable before B1-T1")
