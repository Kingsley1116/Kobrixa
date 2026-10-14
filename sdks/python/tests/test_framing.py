import unittest
from kobrixa._framing import Decoder, FramingError, encode


class FramingTest(unittest.TestCase):
    def test_round_trip_split_utf8(self):
        frame = encode('{"a":"插件😀"}') + encode("{}")
        decoder = Decoder()
        received = []
        for index in range(len(frame)):
            received += decoder.push(frame[index:index + 1])
        self.assertEqual(received, ['{"a":"插件😀"}', "{}"])

    def test_rejects_bad_frames(self):
        for data in [b"Content-Type: x\r\n\r\n{}", b"hello\r\n\r\n", b"debug\n", b"x" * 1025,
                     b"Content-Length: 1048577\r\n\r\n", b"Content-Length: 1\r\n\r\n\xff"]:
            with self.subTest(data=data[:20]):
                with self.assertRaises(FramingError):
                    Decoder().push(data)
