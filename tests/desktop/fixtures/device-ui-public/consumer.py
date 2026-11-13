"""Synthetic acceptance.device-stdio consumer; not the EV3 product or hardware proof."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import uuid
from kobrixa import Plugin

ROLE = sys.argv[1]
ID = 'acceptance.device-stdio' + ('' if ROLE == 'owner' else '-denied')
plugin = Plugin()
ready_event = asyncio.Event()
session = channels = None


def value(result):
    assert result['ok'] is True, repr(result)
    return result['value']


def refused(result, code):
    assert result['ok'] is False and result['error']['code'] == code, repr(result)


def note(stage, **data):
    print('DEVICE_STDIO:' + json.dumps({'role': ROLE, 'stage': stage, 'pid': os.getpid(), **data}), file=sys.stderr, flush=True)


@plugin.ready
async def ready(_ctx):
    ready_event.set()
    note('ready')


async def wait_for(check):
    async def poll():
        while not check():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), 8)


@plugin.command(ID + '.run')
async def run(ctx):
    global session, channels
    if ROLE == 'denied':
        refused(await ctx.devices.connect({'target': {'kind': 'wifi-address', 'providerId': 'kobrixa.device-ev3', 'address': '127.0.0.1'}}), 'PLUGIN_E_PERMISSION_DENIED')
        snapshot = value(await ctx.settings.read({'schemaVersion': 1}))
        refused(await ctx.settings.update({'schemaVersion': 1, 'expectedRevision': snapshot['revision'], 'changes': [{'key': 'enabled', 'value': True}]}), 'PLUGIN_E_PERMISSION_DENIED')
        note('done')
        return
    # Only the UI owner negotiates ui/ready; legacy command-only activation does not.
    await asyncio.wait_for(ready_event.wait(), 5)
    found = value(await ctx.devices.discover({'providerId': 'kobrixa.device-ev3'}))['candidates']
    assert found
    connected = value(await ctx.devices.connect({'target': {'kind': 'candidate', 'candidateId': found[0]['candidateId']}}))['session']
    session = connected['sessionId']
    sources = value(await ctx.devices.session({'sessionId': session}))['sources']
    channels = [sources['channels'][0]['channelId']]
    read = value(await ctx.devices.read({'sessionId': session, 'channelIds': channels, 'freshness': 'fresh'}))
    assert read['status'] == 'fresh' and read['frame']['values'][0]['value'] == 42
    params = {'sessionId': session, 'portId': sources['channels'][0]['portId'], 'expectedSourceRevision': sources['sourceRevision']}
    modes = value(await ctx.devices.input_modes.query(params))
    assert modes['modes']
    refused(await ctx.devices.input_modes.query({**params, 'expectedSourceRevision': sources['sourceRevision'] + 1}), 'PLUGIN_E_STALE_RESOURCE')
    refused(await ctx.devices.session({'sessionId': str(uuid.uuid4())}), 'PLUGIN_E_STALE_RESOURCE')
    context = value(await ctx.devices.context({}))
    switched = value(await ctx.devices.input_modes.set({**params, 'modeId': modes['modes'][0]['modeId'], 'contextRef': context['contextRef']}))
    assert switched['sources']['sourceRevision'] == sources['sourceRevision'] + 1
    channels = [switched['sources']['channels'][0]['channelId']]


    original = value(await ctx.settings.read({'schemaVersion': 1}))
    assert original['revision'] is None and original['values'] == [{'key': 'enabled', 'value': False}]
    events = []
    watched = value(await ctx.settings.watch({'schemaVersion': 1}, lambda event: events.append(event)))
    changed = value(await ctx.settings.update({'schemaVersion': 1, 'expectedRevision': original['revision'], 'changes': [{'key': 'enabled', 'value': True}]}))
    refused(await ctx.settings.update({'schemaVersion': 1, 'expectedRevision': original['revision'], 'changes': [{'key': 'enabled', 'value': False}]}), 'PLUGIN_E_SETTINGS_CONFLICT')
    await wait_for(lambda: len(events) >= 1)
    reset = value(await ctx.settings.reset({'schemaVersion': 1, 'expectedRevision': changed['snapshot']['revision'], 'keys': ['enabled']}))
    assert reset['snapshot']['values'] == original['values']
    await wait_for(lambda: len(events) >= 2)
    value(await ctx.settings.unwatch({'subscriptionId': watched['subscriptionId']}))
    count = len(events)
    final = value(await ctx.settings.update({'schemaVersion': 1, 'expectedRevision': reset['snapshot']['revision'], 'changes': [{'key': 'enabled', 'value': True}]}))
    assert value(await ctx.settings.read({'schemaVersion': 1})) == final['snapshot']
    await asyncio.sleep(0.05)
    assert len(events) == count

    binding = next(b for b in value(await ctx.ui.instances())['instances'] if b['kind'] == 'panel')
    header = {'kind': 'table'}
    for revision in (1, 2):
        rows = [{'key': found[0]['candidateId'], 'version': str(revision), 'cells': ['candidate']}, {'key': 'mode:' + modes['modes'][0]['modeId'], 'version': str(revision), 'cells': [modes['modes'][0]['name']]}]
        canonical = json.dumps([header, rows], separators=(',', ':'), ensure_ascii=False).encode()
        address = {'binding': binding, 'dataset': 'rows'}
        opened = value(await ctx.ui.data.begin({**address, 'baseRevision': revision - 1, 'presentation': revision, 'header': header, 'entryCount': len(rows), 'byteLength': len(canonical), 'sha256': hashlib.sha256(canonical).hexdigest()}))
        transfer = {**address, 'transfer': opened['transfer']}
        value(await ctx.ui.data.chunk({**transfer, 'offset': 0, 'chunk': {'kind': 'table', 'entries': rows}}))
        committed = value(await ctx.ui.data.commit(transfer))
        assert committed['revision'] == revision
        page = value(await ctx.ui.data.read({**address, 'revision': revision, 'offset': 0, 'limit': 50}))
        assert page['chunk']['entries'] == rows
    refused(await ctx.ui.data.read({**address, 'revision': 1, 'offset': 0, 'limit': 50}), 'PLUGIN_E_STALE_RESOURCE')
    note('done')


@plugin.command(ID + '.cancel')
async def cancel(ctx):
    task = asyncio.create_task(ctx.devices.read({'sessionId': session, 'channelIds': channels, 'freshness': 'fresh'}))
    try:
        await wait_for(lambda: Path('cancel.json').exists())
        task.cancel()
        try:
            await task
            raise AssertionError('Read cancellation was ignored')
        except asyncio.CancelledError:
            note('cancelled')
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


plugin.run()
