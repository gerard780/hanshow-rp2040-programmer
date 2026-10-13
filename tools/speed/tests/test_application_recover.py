"""Original-backup recovery guards and CLI transaction tests without hardware."""
import contextlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
import application_recover as recovery


def fixture():
    original = bytes(range(256)) * 2048
    report = dict(apply=True, verified=False, cpuKeptHalted=True, chipId="026255",
                  jedecId="eb6013", bridgeVersion="1.6", applicationBytes=0x20000,
                  protectionOriginal=44, flashUid="01020304050607080910111213141516",
                  backupSha256=recovery.digest(original))
    return original, report


class RecoveryTests(unittest.TestCase):
    def test_backup_report_guards(self):
        original, report = fixture()
        recovery.validate_source(report, original)
        for change in [dict(backupSha256="0" * 64), dict(cpuKeptHalted=False),
                       dict(chipId="other"), dict(protectionOriginal=255), dict(applicationBytes=4096),
                       dict(flashUid="ff" * 16), dict(verified=True)]:
            with self.assertRaises(RuntimeError): recovery.validate_source({**report, **change}, original)
        with self.assertRaises(RuntimeError): recovery.validate_source(report, original[:0x20000])
        for blank in [bytes(0x80000), b'\xff' * 0x80000]:
            with self.assertRaises(RuntimeError): recovery.validate_source({**report,'backupSha256':recovery.digest(blank)},blank)

    def test_order_and_factory_preservation(self):
        original, _ = fixture()
        current = bytearray(original)
        for address in (0x3000, 0x7000, 0): current[address] ^= 1
        self.assertEqual(recovery.recovery_order(original, current), [0x3000, 0x7000, 0])
        current[0x78000] ^= 1
        with self.assertRaisesRegex(RuntimeError, "Factory/identity/calibration"):
            recovery.recovery_order(original, current)

    def run_cli(self, *, apply=False, fail_write=False, wrong_uid=False, corrupt_tail=False):
        original, report = fixture()
        memory = bytearray(original)
        for address in (0x3000, 0x4000, 0x5000, 0x6000, 0x7000): memory[address] ^= 1
        if corrupt_tail: memory[0x7e000] ^= 1
        model = SimpleNamespace(memory=memory, tx=0, protection=0, writes=[], resets=0)

        class Port:
            def __init__(self, **options):
                self.options = options; self.dtr = self.rts = False
            def open(self):
                assert self.options['baudrate'] == 921600 and not self.dtr and not self.rts
            def close(self): pass
            def reset_input_buffer(self): pass

        class Device:
            serial_number = 'SIMULATED'
            def ctrl_transfer(self, kind, request, *args, **kwargs):
                if request == 1: return struct.pack('<10I', 0, 0, 0, 0, 0, 0, model.tx, 0, 0, 0)
                return b''

        class Flash:
            def __init__(self, *args, **kwargs):
                self.protection = None
            def spi(self, command, count):
                if command[0] == 0x9f: return bytes.fromhex('eb6013')
                return bytes.fromhex('99' * 16 if wrong_uid else report['flashUid'])
            def read_sector(self, address): return bytes(model.memory[address:address + 4096])
            def ready(self): pass
            def status(self): return model.protection
            def _set_status(self, value): model.protection = value
            def restore_protection(self): model.protection = self.protection
            def begin_measurement(self): pass
            def rewrite_sector(self, address, data, before):
                assert bytes(model.memory[address:address + 4096]) == before
                model.writes.append(address)
                model.memory[address:address + 4096] = data
                if fail_write: raise RuntimeError('Injected recovery failure')

        def write_register(port, address, data):
            if address == 0x6f:
                assert data == [0x22] and bytes(model.memory) == original and model.protection == 44
                model.resets += 1
            else: assert address == 0x602 and bytes(data) == b'\x05'
            return True

        def stop(*args): model.tx += 10; return True
        reader = SimpleNamespace(rd_wr_usbcom_blk=stop, sws_code_end=lambda: [],
                                 rd_sws_wr_addr_usbcom=write_register,
                                 set_sws_auto_speed=lambda port: True,
                                 set_sws_speed=lambda port, clk: True,
                                 sws_read_data=lambda *args: [2, 0x62, 0x55])
        spec = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda module: None))
        device = Device()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root/'backup.bin').write_bytes(original)
            (root/'report.json').write_text(json.dumps(report))
            argv = ['recover_application.py','--backup',str(root/'backup.bin'),'--report',str(root/'report.json'),
                    '--port','/dev/fake-sws','--bridge-serial','SIMULATED','--output',str(root/'capture'),
                    '--reset-wire-disconnected'] + (['--apply'] if apply else [])
            with contextlib.ExitStack() as stack:
                for target, value in [
                    ('sys.argv',argv),('application_recover.serial.Serial',Port),
                    ('application_recover.usb.core.find',lambda **kw: [device]),
                    ('application_recover.serial.tools.list_ports.comports',lambda:[SimpleNamespace(device='/dev/fake-sws',vid=0xcafe,pid=0x4012,serial_number='SIMULATED')]),
                    ('application_recover.bench.bridge_status',lambda d:{'version':'1.6'}),
                    ('application_recover.bench.select_825x_width',lambda d: None),
                    ('application_recover.bench.block_read',lambda *args:b'\x05'),
                    ('application_recover.importlib.util.spec_from_file_location',lambda *args:spec),
                    ('application_recover.importlib.util.module_from_spec',lambda s:reader),
                    ('application_recover.ConservativeFlash',Flash),
                ]: stack.enter_context(patch(target,value))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                failure = None
                try: recovery.main()
                except SystemExit as error: failure = error
            result = json.loads((root/'capture/recovery-report.json').read_text())
        return model, result, failure

    def test_full_restoration_verifies_original_and_protection_before_reset(self):
        model, result, failure = self.run_cli(apply=True)
        self.assertIsNone(failure)
        self.assertEqual(model.writes,[0x3000,0x4000,0x5000,0x6000,0x7000])
        self.assertEqual(model.resets,1)
        self.assertTrue(result['verified'] and result['cpu_reset_verified'])

    def test_read_only_check_does_not_write_or_reset(self):
        model, result, failure = self.run_cli()
        self.assertIsNone(failure)
        self.assertEqual(model.writes,[]); self.assertEqual(model.resets,0)
        self.assertTrue(result['check_passed'] and result['cpu_kept_halted'])

    def test_wrong_uid_and_changed_factory_data_prevent_all_writes(self):
        for flags in [dict(wrong_uid=True),dict(corrupt_tail=True)]:
            model, result, failure = self.run_cli(apply=True,**flags)
            self.assertIsNotNone(failure); self.assertEqual(model.writes,[]); self.assertEqual(model.resets,0)
            self.assertTrue(result['cpu_kept_halted'])

    def test_partial_recovery_failure_never_resets_cpu(self):
        model, result, failure = self.run_cli(apply=True,fail_write=True)
        self.assertIsNotNone(failure); self.assertEqual(model.resets,0)
        self.assertTrue(result['cpu_kept_halted'] and not result['verified'])


if __name__ == '__main__':
    unittest.main()
