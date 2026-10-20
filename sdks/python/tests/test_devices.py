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
