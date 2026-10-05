"""Inspect descriptors in the compiled RP2040 image and its shipped UF2."""
import json
import os
from pathlib import Path
import struct
import subprocess
import unittest
import hashlib

ROOT = Path(__file__).resolve().parents[2]
BUILD = Path(os.environ.get('PROGRAMMER_BUILD_DIR', str(ROOT / 'build')))
DIST = ROOT / 'dist'


class FirmwareDescriptors(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.image = (BUILD / 'hanshow_pio_bridge.bin').read_bytes()
        cls.symbols = {}
        for line in subprocess.check_output([os.environ.get('PROGRAMMER_NM', 'nm'), '-S', str(BUILD / 'hanshow_pio_bridge.elf')], text=True).splitlines():
            fields = line.split()
            if len(fields) == 4:
                cls.symbols[fields[3]] = (int(fields[0], 16), int(fields[1], 16))

    def descriptor(self, name):
        address, size = self.symbols[name]
        return self.image[address - 0x10000000:address - 0x10000000 + size]

    def test_device_and_interfaces(self):
        device = self.descriptor('device')
        self.assertEqual(struct.unpack_from('<H', device, 2)[0], 0x0210)
        self.assertEqual(struct.unpack_from('<HHH', device, 8), (0xcafe, 0x4012, 0x0105))
        configuration = self.descriptor('configuration')
        self.assertEqual(struct.unpack_from('<H', configuration, 2)[0], len(configuration))
        self.assertEqual(configuration[4], 5)
        offset = 0
        interfaces = []
        while offset < len(configuration):
            length, kind = configuration[offset:offset + 2]
            self.assertGreater(length, 0)
            if kind == 4:
                interfaces.append(tuple(configuration[offset + i] for i in (2, 4, 5)))
            offset += length
        self.assertEqual(offset, len(configuration))
        self.assertEqual(interfaces, [(0,1,2), (1,2,10), (2,1,2), (3,2,10), (4,0,255)])

    def test_bos_and_windows_binding(self):
        bos = self.descriptor('bos')
        self.assertEqual(struct.unpack_from('<H', bos, 2)[0], len(bos))
        self.assertEqual(bos[4], 1)
        self.assertEqual(struct.unpack_from('<H', bos, 29)[0], 178)
        self.assertEqual(bos[31], 0x30)
        os_descriptor = self.descriptor('ms_os')
        self.assertEqual(len(os_descriptor), 178)
        self.assertEqual(struct.unpack_from('<H', os_descriptor, 8)[0], 178)
        self.assertEqual(os_descriptor[22], 4)  # only the vendor interface uses WinUSB
        self.assertEqual(os_descriptor[30:38], b'WINUSB\0\0')
        self.assertEqual(os_descriptor[54:96].decode('utf-16le'), 'DeviceInterfaceGUIDs\0')
        self.assertEqual(struct.unpack_from('<H', os_descriptor, 96)[0], 80)
        self.assertEqual(os_descriptor[98:].decode('utf-16le'), '{A5D8042E-47D3-4B12-963A-89E0214FC6B8}\0\0')

    def test_shipped_uf2_matches_build_and_manifest(self):
        path = DIST / 'hanshow_pio_bridge.uf2'
        uf2 = path.read_bytes()
        reconstructed = bytearray()
        self.assertEqual(len(uf2) % 512, 0)
        for index, offset in enumerate(range(0, len(uf2), 512)):
            block = uf2[offset:offset + 512]
            fields = struct.unpack_from('<8I', block)
            self.assertEqual(fields[:3], (0x0a324655, 0x9e5d5157, 0x2000))
            self.assertEqual(fields[3:8], (0x10000000 + index * 256, 256, index, len(uf2) // 512, 0xe48bff56))
            self.assertEqual(struct.unpack_from('<I', block, 508)[0], 0x0ab16f30)
            reconstructed.extend(block[32:288])
        self.assertEqual(reconstructed[:len(self.image)], self.image)
        manifest = json.loads((DIST / 'manifest.json').read_text())
        self.assertEqual(hashlib.sha256(uf2).hexdigest(), manifest['uf2_sha256'])


if __name__ == '__main__':
    unittest.main()
