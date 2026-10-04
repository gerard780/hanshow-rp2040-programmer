import io
import struct
import unittest
from unittest.mock import patch

import readback


class Reader:
    def __init__(self, chip=(2, 0x62, 0x55), jedec=(0xEF, 0x40, 0x15)):
        self.chip, self.jedec = list(chip), list(jedec)
        self.writes, self.samples = [], []
        self.fail_release = False

    def sws_read_data(self, port, address, count):
        return self.chip if address == 0x7D else self.jedec

    def rd_sws_wr_addr_usbcom(self, port, address, data):
        self.writes.append((address, bytes(data)))
        if address == 0x0C:
            assert data[0] in (0x03, 0x9F), "A flash-modifying opcode was issued"
        return not (self.fail_release and address == 0x0D)

    def FlashReadBlock(self, port, stream, offset, count):
        stream.write(self.samples.pop(0) if self.samples else bytes(range(256)) * (count // 256))
        return True

    def sws_code_end(self):
        return b"stop"

    def rd_wr_usbcom_blk(self, port, data):
        self.writes.append((None, data))
        return True


class Port:
    def reset_input_buffer(self): pass
    def flush(self): pass


class Device:
    def __init__(self): self.width = 3
    def ctrl_transfer(self, kind, request, value, index, data, **kwargs):
        assert request == 0x21
        if kind == 0x40:
            self.width = value
            return 0
        return struct.pack("<I", self.width)


class ReadbackTests(unittest.TestCase):
    def test_other_chip_and_flash_are_probed_without_chip_allowlist(self):
        reader = Reader(chip=(1, 0x80, 0x82), jedec=(0xC8, 0x40, 0x17))
        info = readback.identify(reader, Port())
        self.assertEqual(info["chip_register_bytes"], "018082")
        self.assertEqual(info["detected_flash_bytes"], 8 * 1024 * 1024)
        self.assertEqual(reader.writes[-2:], [(0x0D, b"\1"), (0xB3, b"\0")])

    def test_capacity_and_address_boundaries(self):
        for exponent in (16, 19, 21, 24):
            self.assertEqual(readback.capture_size(None, readback.capacity(bytes((0xEF, 0x40, exponent)))), 1 << exponent)
        with self.assertRaises(RuntimeError): readback.capture_size(None, 1 << 25)
        with self.assertRaises(RuntimeError): readback.capture_size(1 << 20, 1 << 19)
        with self.assertRaises(RuntimeError): readback.capture_size(None, None)
        self.assertEqual(readback.capture_size(524288, None), 524288)

    def test_blank_chip_and_invalid_jedec_fail(self):
        for chip in ((0, 0, 0), (255, 255, 255)):
            with self.assertRaises(RuntimeError): readback.identify(Reader(chip=chip), Port())
        for jedec in (b"\0\0\0", b"\xff\xff\xff", b"\xef\0\x13"):
            with self.assertRaises(RuntimeError): readback.capacity(jedec)

    def test_repeated_id_failure_releases_spi(self):
        reader = Reader()
        calls = []
        def read(port, address, count):
            if address == 0x7D: return reader.chip
            calls.append(address)
            return [0xEF, 0x40, 0x13 if len(calls) == 1 else 0x14]
        reader.sws_read_data = read
        with self.assertRaises(RuntimeError): readback.identify(reader, Port())
        self.assertEqual(reader.writes[-2:], [(0x0D, b"\1"), (0xB3, b"\0")])

    def test_preflight_requires_matching_nonblank_samples(self):
        for a, b in ((b"\0" * 4096, b"\0" * 4096), (b"\xff" * 4096, b"\xff" * 4096), (b"a" * 4096, b"b" * 4096)):
            reader = Reader(); reader.samples = [a, b]
            with self.assertRaises(RuntimeError): readback.preflight(reader, Port(), None, "legacy", 4096)
        self.assertEqual(len(readback.preflight(Reader(), Port(), None, "legacy", 4096)), 64)

    def test_cleanup_attempts_reset_even_after_release_failure(self):
        reader = Reader(); reader.fail_release = True
        with patch("readback.time.sleep"), self.assertRaises(RuntimeError):
            readback.finish(reader, Port(), None, "legacy")
        self.assertIn((0x6F, b"\x22"), reader.writes)

    def test_both_address_widths_verify_and_old_bridge_rejects_826x(self):
        device = Device()
        with patch("readback.bridge_status", return_value={"version": "1.3"}):
            for family, width in (("826x", 2), ("825x", 3)):
                readback.select_width(device, family)
                self.assertEqual(device.width, width)
        with patch("readback.bridge_status", return_value={"version": "1.2"}):
            with self.assertRaises(RuntimeError): readback.select_width(device, "826x")


if __name__ == "__main__": unittest.main()
