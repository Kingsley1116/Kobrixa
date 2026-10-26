import asyncio
import copy
import inspect
import json
from ._schema import Validator, SchemaError

def _size(value): return len(json.dumps(value,ensure_ascii=True,separators=(',',':')).encode('utf-8'))
class EventInbox:
    def __init__(self,ack,owner):
        self._owner=dict(owner)
        self._acks=set()
        self._terminal_handler = None
        self._terminal_jobs = []
        self._early_terminal = {}
        self._cancelled_early = set()
        self._ack=ack;self._enabled=False;self._pending=0;self._early=[];self._slots={};self._validator=Validator.bundled()
    def enable(self): self._enabled=True
    def begin_subscription(self):
        self._pending+=1
        def finish():
            self._pending-=1
            if not self._pending:
                self._early=[]
                self._early_terminal.clear()
                self._cancelled_early.clear()
                for job in self._terminal_jobs:
                    job['wake'].set(); job['carrier_ready'].set()
        return finish
    def adopt_terminal(self, event, prepare):
        job = next((job for job in self._terminal_jobs if job['event'] is event), None)
        if job is None: raise RuntimeError('Terminal adoption expired')
        run = prepare()
        if run is not None: job['late'].append(run)
        job['wake'].set()

    def open(self,id,listener,resync,sequence=0):
        if len(self._slots)>=32: raise ValueError('Subscription queue full')
        self._slots[id]={'last':sequence,'watermark':sequence,'owner':None,'queue':[],'bytes':0,'controls':0,'task':None,'terminal':False,'listener':listener,'resync':resync}
        terminal = self._early_terminal.get(id)
        if terminal is not None:
            slot = self._slots[id]
            slot['terminal'] = True
            job = next((job for job in self._terminal_jobs if job['event'] is terminal), None)
            if job is not None and terminal['subscriptionId'] == id:
                job['carrier'] = slot
                job['carrier_ready'].set()
        early,self._early=self._early,[]
        for event in early:
            if event['subscriptionId']==id: self.accept(event)
            else: self._early.append(event)
    def reconcile(self,id,sequence):
        slot=self._slots.get(id)
        if slot is None or sequence < slot['watermark']: return
        slot['watermark']=sequence
        slot['last']=max(slot['last'],sequence)
    def last(self,id): return self._slots.get(id,{}).get('last',0)
    def close(self,id):
        if id in self._early_terminal: self._cancelled_early.add(id)
        slot=self._slots.pop(id,None)
        self._early=[event for event in self._early if event['subscriptionId']!=id]
        if slot and slot['task'] and slot['task'] is not asyncio.current_task(): slot['task'].cancel()
    def accept(self,event):
        if not self._enabled: return False
        try: self._validator.validate('events/deliver.params',event)
        except (SchemaError,ValueError): return False
        if event['owner']!=self._owner: return False
        event = copy.deepcopy(event)
        slot=self._slots.get(event['subscriptionId']);size=_size(event)
        if event['kind'] == 'events.resyncRequired' and self._terminal_handler is not None:
            if ((slot is None and not self._pending) or (slot is not None and (slot['terminal'] or event['sequence'] <= slot['last'])) or
                any(job['event']['subscriptionId'] == event['subscriptionId'] for job in self._terminal_jobs) or
                event['subscriptionId'] in self._early_terminal): return False
            affected = set(self._early_terminal) | set(event['data']['affected'])
            for job in self._terminal_jobs: affected.update(job['event']['data']['affected'])
            if (len(affected) > 32 or len(self._terminal_jobs) + sum(s['controls'] for s in self._slots.values()) >= 8 or
                (slot is None and len(self._early) + len(self._terminal_jobs) >= 8)): return False
            job = {'event':event, 'late':[], 'wake':asyncio.Event(), 'task':None, 'carrier':slot, 'carrier_ready':asyncio.Event()}
            self._terminal_jobs.append(job)
            if slot is not None: slot['last'] = event['sequence']
            for id in event['data']['affected']:
                if id in self._slots: self._slots[id]['terminal'] = True
            if self._pending:
                for id in event['data']['affected']: self._early_terminal[id] = event
            task = asyncio.create_task(self._ack_safe(event['subscriptionId'], event['sequence']))
            self._acks.add(task); task.add_done_callback(self._acks.discard)
            ui = self._terminal_handler(event)
            async def legacy():
                if job['carrier'] is None and self._pending: await job['carrier_ready'].wait()
                slot = job['carrier']
                if slot is None or self._slots.get(event['subscriptionId']) is not slot: return
                if slot['task'] is not None:
                    await asyncio.gather(asyncio.shield(slot['task']), return_exceptions=True)
                if self._slots.get(event['subscriptionId']) is not slot: return
                await slot['resync']()
                if self._slots.get(event['subscriptionId']) is slot:
                    result = slot['listener'](event)
                    if inspect.isawaitable(result): await result
            async def deliver_ui():
                if ui is not None: await asyncio.gather(ui(), return_exceptions=True)
                while True:
                    if job['late']:
                        run = job['late'].pop(0)
                        await asyncio.gather(run(), return_exceptions=True)
                        continue
                    if not self._pending: break
                    job['wake'].clear()
                    await job['wake'].wait()
            async def deliver():
                try:
                    await asyncio.gather(legacy(), deliver_ui(), return_exceptions=True)
                finally:
                    if job in self._terminal_jobs: self._terminal_jobs.remove(job)
            job['task'] = asyncio.create_task(deliver())
            return True
        if slot is None:
            if not self._pending or len(self._early)+len(self._terminal_jobs)>=8 or sum(map(_size,self._early))+size>262144: return False
            self._early.append(event);return True
        if slot['terminal']: return False
        owner=json.dumps(event['owner'],sort_keys=True)
        if slot['owner'] is not None and slot['owner']!=owner or event['sequence']<=slot['last']: return False
        if (sum(s['controls'] for s in self._slots.values())+len(self._terminal_jobs)>=8 if event['delivery']=='control' else sum(s['bytes'] for s in self._slots.values())+sum(map(_size,self._early))+sum(_size(job['event']) for job in self._terminal_jobs)+size>262144): return False
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
                    if self._slots.get(event['subscriptionId']) is not slot: return
                    if gap or event['kind']=='events.resyncRequired':await slot['resync']()
                    if self._slots.get(event['subscriptionId']) is not slot: return
                    if event['sequence']>slot['watermark']:
                        result=slot['listener'](event)
                        if inspect.isawaitable(result):await result
                    if self._slots.get(event['subscriptionId']) is not slot: return
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
        inbox._early_terminal.clear()
        inbox._cancelled_early.clear()
        for job in list(inbox._terminal_jobs):
            if job['task']: job['task'].cancel()
        inbox._terminal_jobs.clear()
        for task in list(inbox._acks): task.cancel()
        inbox._acks.clear()
        peer.devices.inbox = None

class _UiEventClientPort:
    def __init__(self, peer):
        self.peer = peer

    def terminal(self, handler):
        _BOUND[self.peer]._terminal_handler = handler

    def cancelled(self, id):
        return id in _BOUND[self.peer]._cancelled_early

    def pending_terminal(self, id):
        return _BOUND[self.peer]._early_terminal.get(id)

    def adopt_terminal(self, event, prepare):
        _BOUND[self.peer].adopt_terminal(event, prepare)

    def current(self):
        epoch = getattr(self.peer, '_ui_epoch', None)
        inbox = _BOUND.get(self.peer)
        return lambda: (_BOUND.get(self.peer) is inbox and inbox is not None and
                        not getattr(self.peer, '_stopping', False) and getattr(self.peer, '_ui_epoch', None) == epoch)

    def begin(self):
        _BOUND[self.peer].enable()
        return _BOUND[self.peer].begin_subscription()

    def adopt(self, subscription_id, sequence, snapshot, listener):
        epoch = getattr(self.peer, "_ui_epoch", None)
        inbox = _BOUND[self.peer]
        inbox.enable()
        current = self.current()
        async def resync():
            if not current(): return
            result = await snapshot()
            if not current(): return
            if not result["ok"]:
                raise ValueError(result["error"]["message"])
            inbox.reconcile(subscription_id, result["value"]["sequence"])
        def receive(event):
            if not current(): return
            if event["kind"] == "ui.data" and (getattr(self.peer, "_ui_epoch", None) != epoch or not getattr(self.peer, "_ui_data_ready", False)):
                return
            if event["kind"].startswith("ui."):
                return listener(event)
        inbox.open(subscription_id, receive, resync, sequence)

    def forget(self, subscription_id):
        _BOUND[self.peer].close(subscription_id)

def ui_event_client_port(peer):
    return _UiEventClientPort(peer)


class _SettingsEventClient:
    def __init__(self, peer, client):
        self._peer = peer
        self._client = client

    def __getattr__(self, name):
        return getattr(self._client, name)

    async def watch(self, params, listener=None):
        inbox = _BOUND[self._peer]
        inbox.enable()
        finish = inbox.begin_subscription()
        try:
            result = await self._client.watch(params)
            if result["ok"]:
                refreshed = None
                slot = None
                async def resync():
                    nonlocal refreshed
                    snapshot = await self._client.read(params)
                    if not snapshot["ok"]:
                        raise ValueError(snapshot["error"]["message"])
                    refreshed = snapshot["value"]
                async def receive(event):
                    nonlocal refreshed
                    # Delivery begins only after the shared pump's slot ownership check.
                    if _BOUND.get(self._peer) is not inbox:
                        return
                    snapshot, refreshed = refreshed, None
                    if listener is not None and snapshot is not None:
                        pending = listener({"type": "snapshot", "snapshot": snapshot})
                        if inspect.isawaitable(pending):
                            await pending
                    if (_BOUND.get(self._peer) is not inbox or
                            inbox._slots.get(event["subscriptionId"]) is not slot):
                        return
                    if event["kind"] == "settings.changed" and listener is not None:
                        pending = listener({"type": "event", "event": event})
                        if inspect.isawaitable(pending):
                            await pending
                inbox.open(result["value"]["subscriptionId"], receive, resync, result["value"]["sequence"])
                slot = inbox._slots.get(result["value"]["subscriptionId"])
            return result
        finally:
            finish()

    async def unwatch(self, params):
        result = await self._peer._request("events/unsubscribe", params)
        if result["ok"] and self._peer in _BOUND:
            _BOUND[self._peer].close(params["subscriptionId"])
        return result


def settings_event_client(peer, client):
    return _SettingsEventClient(peer, client)
