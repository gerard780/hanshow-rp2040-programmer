"""Validate plan binding and recovery using actual installer/backend logic."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import zlib
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))
with patch.dict(sys.modules, {name: Mock() for name in
                            ("serial", "serial.tools", "serial.tools.list_ports", "usb", "usb.core")}):
    validation = importlib.import_module("application_install")


class InstallerTests(unittest.TestCase):
    def exercise(self, *, recover=True, apply=True, ignore_erase=False, baud=None, fail=True, stale=False, fail_page=2, restore_fails=False, corrupt_upper=False):
        original = bytearray(b"\xff" * validation.FLASH_BYTES)
        original[:8192] = bytes(range(256)) * 32
        struct.pack_into("<I", original, 24, 8192)
        original = bytes(original)
        firmware = bytearray(original[:8192])
        firmware[8:12] = b"KNLT"
        firmware[500] ^= 1
        firmware[5000] ^= 1
        struct.pack_into("<I", firmware, len(firmware)-4, zlib.crc32(firmware[:-4]) ^ 0xffffffff)
        expected = bytes(firmware) + original[len(firmware):]
        live = bytearray(original)
        state = {"protection": 0x2c, "native_failed": False, "native_pages": 0, "erases": 0, "erase_order": []}
        resets = []
        reader = Mock()
        reader.set_sws_auto_speed.return_value = reader.set_sws_speed.return_value = True
        reader.sws_read_data.side_effect = lambda port, address, count: (
            [2, 0x62, 0x55] if address == 0x7d else [state["protection"] & 255])

        def reset(port, address, data):
            if address == 0x6f and data == [0x22]:
                resets.append((bytes(live) == original, state["protection"]))
            return True
        reader.rd_sws_wr_addr_usbcom.side_effect = reset

        def spi(flash, command, count=0):
            opcode = command[0]
            if opcode == 0x9f:
                return bytes.fromhex("eb6013")
            if opcode == 0x4b:
                return bytes(range(16))
            if opcode in (5, 0x35):
                return bytes([(state["protection"] >> (8 if opcode == 0x35 else 0)) & 255])
            if opcode == 1:
                if restore_fails and command[1] == 0x2c:
                    raise RuntimeError("Protection restoration failed")
                state["protection"] = command[1] | command[2] << 8
            if opcode in (2, 3, 0x20):
                address = int.from_bytes(bytes(command[1:4]), "big")
                if opcode == 3:
                    return bytes(live[address:address + count])
                if opcode == 0x20:
                    if state["native_failed"] and not recover:
                        raise RuntimeError("Recovery transport unavailable")
                    state["erases"] += 1
                    state["erase_order"].append(address)
                    if not ignore_erase:
                        live[address:address + 4096] = b"\xff" * 4096
                if opcode == 2:
                    if len(command) == 260 and not state["native_failed"]:
                        state["native_pages"] += 1
                        if fail and state["native_pages"] == fail_page:
                            state["native_failed"] = True
                            raise RuntimeError("Injected partial page-program failure")
                    live[address:address + len(command) - 4] = bytes(command[4:])
                    if corrupt_upper:
                        live[0x7e000] = 0
            return b""

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pinned = root / "reader.py"
            pinned.write_bytes(b"simulated pinned reader")
            output = root / "validation"
            (root / "application-padded.bin").write_bytes(firmware)
            (root / "expected-full-flash.bin").write_bytes(expected)
            (root / "recovery-application.bin").write_bytes(original[:8192])
            plan = {"hardware_access": False, "write_start": 0, "write_bytes": 8192,
                    "sector_size": 4096, "preserve_start": 8192, "preserve_end": 524288,
                    "backup_sha256": validation.digest(original) if not stale else "wrong",
                    "firmware_sha256": validation.digest(firmware),
                    "expected_full_flash_sha256": validation.digest(expected),
                    "sectors_in_write_order": [4096, 0]}
            plan_path = root / "flash-plan.json"
            plan_path.write_text(json.dumps(plan))
            argv = ["flash_application.py", "--plan", str(plan_path), "--reader", str(pinned), "--port", "/dev/fakezero",
                    "--bridge-serial", "test", "--output", str(output)]
            if apply:
                argv.append("--apply")
            if baud is not None:
                argv.extend(["--baud", str(baud)])
            device = Mock(serial_number="test")
            device.ctrl_transfer.side_effect = lambda kind, *args, **kwargs: (
                b"\x03\x00\x00\x00" if kind == 0xc0 else 0)
            port = Mock()
            serial_port = Mock(device="/dev/fakezero", vid=0xcafe, pid=0x4012, serial_number="test")
            bridge = {"version": "1.5", "sws_faults": 0, "reset_asserted": False}
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(sys, "argv", argv))
                stack.enter_context(patch.object(validation.bench, "READER_HASH", validation.digest(pinned.read_bytes())))
                stack.enter_context(patch.object(validation.usb.core, "find", return_value=[device]))
                stack.enter_context(patch.object(validation.serial.tools.list_ports, "comports", return_value=[serial_port]))
                stack.enter_context(patch.object(validation.serial, "Serial", return_value=Mock(
                    __enter__=Mock(return_value=port), __exit__=Mock(return_value=False))))
                stack.enter_context(patch.object(validation.importlib.util, "spec_from_file_location"))
                stack.enter_context(patch.object(validation.importlib.util, "module_from_spec", return_value=reader))
                stack.enter_context(patch.object(validation.bench, "bridge_status", return_value=bridge))
                stack.enter_context(patch.object(validation.bench, "block_read", return_value=b"\x05"))
                stack.enter_context(patch.object(validation.Flash, "spi", spi))
                stack.enter_context(patch.object(validation.time, "sleep"))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                code = validation.main()
            self.assertEqual(device.ctrl_transfer.call_args_list[0].args[:4], (0xc0, 0x21, 0, 0))
            result = json.loads((output / "application-install.json").read_text())
            self.assertEqual((output / "before-1.bin").read_bytes(), original)
            self.assertEqual((output / "before-2.bin").read_bytes(), original)
            return code, result, resets, state, bytes(live) == original

    def test_partial_program_failure_recovers_before_reset(self):
        code, result, resets, state, preserved = self.exercise(baud=1500000)
        self.assertEqual(code, 1)
        self.assertTrue(result["recovery_verified"])
        self.assertTrue(preserved)
        self.assertEqual(resets, [(True, 0x2c)])
        self.assertEqual(state["protection"], 0x2c)

    def test_failed_recovery_keeps_cpu_halted(self):
        code, result, resets, state, preserved = self.exercise(recover=False)
        self.assertEqual(code, 1)
        self.assertFalse(result["cpu_reset_verified"])
        self.assertFalse(preserved)
        self.assertEqual(resets, [])
        self.assertEqual(state["protection"], 0x2c)

    def test_failure_in_sector_zero_restores_all_attempted_sectors_zero_last(self):
        code, result, resets, state, preserved = self.exercise(fail_page=18)
        self.assertEqual(code, 1)
        self.assertTrue(result["recovery_verified"])
        self.assertTrue(preserved)
        self.assertEqual(state["erase_order"], [4096, 0, 4096, 0])
        self.assertEqual(resets, [(True, 0x2c)])

    def test_protection_restore_failure_prevents_reset_of_new_image(self):
        code, result, resets, state, preserved = self.exercise(fail=False, restore_fails=True)
        self.assertEqual(code, 1)
        self.assertTrue(result["full_flash_equal_expected"])
        self.assertFalse(result["cpu_reset_verified"])
        self.assertEqual(resets, [])

    def test_unexpected_upper_flash_change_prevents_reset(self):
        code, result, resets, state, preserved = self.exercise(fail=False, corrupt_upper=True)
        self.assertEqual(code, 1)
        self.assertFalse(result["verified"])
        self.assertFalse(result["cpu_reset_verified"])
        self.assertEqual(resets, [])

    def test_without_apply_never_erases(self):
        code, result, resets, state, preserved = self.exercise(apply=False)
        self.assertEqual(code, 0)
        self.assertTrue(preserved)
        self.assertEqual(state["erases"], 0)
        self.assertEqual(resets, [(True, 0x2c)])

    def test_stale_plan_never_unlocks_or_erases(self):
        code, result, resets, state, preserved = self.exercise(stale=True)
        self.assertEqual(code, 1)
        self.assertIn("differs from prepared plan", result["errors"][0])
        self.assertTrue(preserved)
        self.assertEqual(state["erases"], 0)
        self.assertEqual(state["protection"], 0x2c)
        self.assertEqual(resets, [(True, 0x2c)])

    def test_ignored_erase_prevents_programming(self):
        code, result, resets, state, preserved = self.exercise(ignore_erase=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["written_sectors"], [])
        self.assertIn("Sector did not become erased", result["errors"][0])
        self.assertTrue(preserved)
        self.assertEqual(resets, [])  # recovery blank check also fails

    def test_success_verifies_entire_image_and_writes_zero_last(self):
        code, result, resets, state, preserved = self.exercise(fail=False)
        self.assertEqual(code, 0)
        self.assertTrue(result["verified"])
        self.assertTrue(result["full_flash_equal_expected"])
        self.assertEqual(result["written_sectors"], ["0x1000", "0x0"])
        self.assertFalse(preserved)
        self.assertEqual(resets, [(False, 0x2c)])
        self.assertEqual(state["erases"], 2)


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.before = bytes(range(256)) * 2048
        firmware = bytearray(self.before[:8192]); firmware[8:12] = b"KNLT"
        struct.pack_into("<I", firmware, 24, len(firmware))
        struct.pack_into("<I", firmware, len(firmware)-4, zlib.crc32(firmware[:-4]) ^ 0xffffffff)
        self.firmware = bytes(firmware)
        self.expected = self.firmware + self.before[8192:]
        self.meta = dict(hardware_access=False, write_start=0, write_bytes=8192,
                         sector_size=4096, preserve_start=8192, preserve_end=524288,
                         backup_sha256=validation.digest(self.before), firmware_sha256=validation.digest(self.firmware),
                         expected_full_flash_sha256=validation.digest(self.expected), sectors_in_write_order=[4096, 0])

    def load(self, **changes):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / "application-padded.bin").write_bytes(self.firmware)
            (path / "expected-full-flash.bin").write_bytes(self.expected)
            (path / "recovery-application.bin").write_bytes(self.before[:8192])
            (path / "flash-plan.json").write_text(json.dumps({**self.meta, **changes}))
            return validation.load_plan(path / "flash-plan.json")

    def test_valid_plan_preserves_factory_flash_and_orders_zero_last(self):
        expected, order = validation.check_against_backup(self.load(), self.before)
        self.assertEqual(expected[0x20000:], self.before[0x20000:])
        self.assertEqual(order, [4096, 0])

    def test_rejects_addresses_and_unexpected_geometry(self):
        for changes in ({"write_start": 4096}, {"write_bytes": 0x21000},
                        {"preserve_end": 0x20000}, {"sector_size": 256}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError): self.load(**changes)

    def test_rejects_crc_and_hash_tampering(self):
        self.firmware = self.firmware[:-1] + bytes([self.firmware[-1] ^ 1])
        self.expected = self.firmware + self.before[8192:]
        self.meta.update(firmware_sha256=validation.digest(self.firmware),
                         expected_full_flash_sha256=validation.digest(self.expected))
        with self.assertRaisesRegex(RuntimeError, "checksum"): self.load()

    def test_rejects_sector_zero_first(self):
        with self.assertRaisesRegex(RuntimeError, "sector zero"):
            validation.check_against_backup(self.load(sectors_in_write_order=[0,4096]), self.before)

    def test_rejects_preserved_flash_change_even_with_matching_plan_hash(self):
        changed = bytearray(self.expected); changed[0x7e000] ^= 1; self.expected = bytes(changed)
        self.meta["expected_full_flash_sha256"] = validation.digest(self.expected)
        with self.assertRaisesRegex(RuntimeError, "preserved flash"):
            validation.check_against_backup(self.load(), self.before)


if __name__ == "__main__": unittest.main()
