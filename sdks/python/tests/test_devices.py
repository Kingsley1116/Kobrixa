import asyncio
import json
import unittest
from pathlib import Path
from kobrixa._schema import Validator, SchemaError
from kobrixa._devices import Devices

class DevicesTests(unittest.IsolatedAsyncioTestCase):
    def test_same_fixtures(self):
        root=Path(__file__).resolve().parents[3]
        directory=root/'packages/plugin-protocol/test-fixtures/device-broker-v1'
        validator=Validator.bundled()
        for kind in ('valid','invalid','maximum'):
            document=json.loads((directory/(kind+'.json')).read_text())
            self.assertEqual(set(document), {'formatVersion','family','cases'})
            self.assertEqual(document['formatVersion'], 1)
            self.assertEqual(document['family'], 'device-broker-v1')
            for fixture in document['cases']:
                self.assertEqual(set(fixture), {'id','schema','phase','input','valid','expected'})
                self.assertIs(type(fixture['valid']), bool)
                self.assertEqual(set(fixture['expected']), {'numericCode','businessCode','reason','permission','lifetime','persistedSha256'})
                self.assertTrue(fixture['schema'].startswith(('devices/','events/')) and validator.has(fixture['schema']))
                with self.subTest(fixture=fixture['id']):
                    if fixture['valid']: validator.validate(fixture['schema'],fixture['input'])
                    else:
                        with self.assertRaises(SchemaError): validator.validate(fixture['schema'],fixture['input'])

    async def test_lazy_negotiation_and_no_replay(self):
        calls=[]
        async def request(method,params,timeout=10):
            calls.append((method,timeout))
            if method=='devices/negotiate':
                return {'ok':True,'value':{'devicesContractVersion':1,'eventVersion':1,'capabilities':[],'requirementsSatisfied':True}}
            raise asyncio.TimeoutError()
        devices=Devices(request)
        self.assertFalse((await devices.list({}))['ok'])
        self.assertEqual(calls,[])
        devices.initialized('1.5.0')
        with self.assertRaises(asyncio.TimeoutError):
            await devices.motion.start({'operationId':'00000000-0000-4000-8000-000000000001'})
        self.assertEqual(calls,[('devices/negotiate',5),('devices/motion/start',5)])

    def test_nonfinite_and_bool(self):
        validator=Validator.bundled()
        for sequence in [True, float('nan'), float('inf'),9007199254740992]:
            with self.assertRaises(SchemaError):
                validator.validate('events/ack.params',{'subscriptionId':'00000000-0000-4000-8000-000000000001','sequence':sequence})

    async def test_failed_negotiation_retries_and_concurrent_calls_share_attempt(self):
        for failure in ('business', 'error', 'timeout'):
            with self.subTest(failure=failure):
                attempts=[]
                calls=[]
                started=asyncio.Queue()
                denied={'ok':False,'error':{'code':'PLUGIN_E_DEVICE_UNAVAILABLE'}}
                async def request(method,params,timeout=10):
                    if method=='devices/negotiate':
                        gate=asyncio.get_running_loop().create_future()
                        attempts.append(gate)
                        started.put_nowait(gate)
                        return await gate
                    calls.append(method)
                    return {'ok':True,'value':{}}
                devices=Devices(request)
                devices.initialized('1.5.0')
                first=asyncio.gather(devices.list({}),devices.list({}),return_exceptions=True)
                gate=await started.get()
                await asyncio.sleep(0)
                self.assertEqual(len(attempts),1)
                if failure=='business':gate.set_result(denied)
                else:gate.set_exception(asyncio.TimeoutError() if failure=='timeout' else RuntimeError('failed'))
                results=await first
                for result in results:
                    if failure=='business':self.assertEqual(result,denied)
                    else:self.assertIsInstance(result,asyncio.TimeoutError if failure=='timeout' else RuntimeError)
                self.assertEqual(calls,[])
                retry=asyncio.gather(devices.list({}),devices.list({}),return_exceptions=True)
                try:
                    gate=await asyncio.wait_for(started.get(),0.1)
                    await asyncio.sleep(0)
                    self.assertEqual(len(attempts),2)
                    gate.set_result({'ok':True,'value':{}})
                    self.assertTrue(all(result['ok'] for result in await retry))
                    self.assertTrue((await devices.list({}))['ok'])
                    self.assertEqual(len(attempts),2)
                    self.assertEqual(calls,['devices/list']*3)
                finally:
                    retry.cancel()
                    await asyncio.gather(retry,return_exceptions=True)
