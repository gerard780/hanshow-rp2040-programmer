"""Exercise recovery and CPU reset gating with simulated flash failures."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))
with patch.dict(sys.modules, {name: Mock() for name in
                            ("serial", "serial.tools", "serial.tools.list_ports", "usb", "usb.core")}):
    validation = importlib.import_module("write_validation")


class ValidationTests(unittest.TestCase):
    def exercise(self, *, recover=True, apply=True, ignore_erase=False, baud=None):
        original = bytearray(b"\xff" * validation.FLASH_BYTES)
        original[:8192] = bytes(range(256)) * 32
        struct.pack_into("<I", original, 24, 8192)
        original = bytes(original)
        live = bytearray(original)
        state = {"protection": 0x2c, "native_failed": False, "native_pages": 0, "erases": 0}
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
                state["protection"] = command[1] | command[2] << 8
            if opcode in (2, 3, 0x20):
                address = int.from_bytes(bytes(command[1:4]), "big")
                if opcode == 3:
                    return bytes(live[address:address + count])
                if opcode == 0x20:
                    if state["native_failed"] and not recover:
                        raise RuntimeError("Recovery transport unavailable")
                    state["erases"] += 1
                    if not ignore_erase:
                        live[address:address + 4096] = b"\xff" * 4096
                if opcode == 2:
                    if len(command) == 260 and not state["native_failed"]:
                        state["native_pages"] += 1
                        if state["native_pages"] == 2:
                            state["native_failed"] = True
                            raise RuntimeError("Injected partial page-program failure")
                    live[address:address + len(command) - 4] = bytes(command[4:])
            return b""

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pinned = root / "reader.py"
            pinned.write_bytes(b"simulated pinned reader")
            output = root / "validation"
            argv = ["write_validation.py", "--reader", str(pinned), "--port", "/dev/fakezero",
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
            self.assertEqual(device.ctrl_transfer.call_args_list[0].args[:4], (0x40, 0x21, 3, 0))
            result = json.loads((output / "validation.json").read_text())
            self.assertEqual((output / "before-1.bin").read_bytes(), original)
            self.assertEqual((output / "before-2.bin").read_bytes(), original)
            return code, result, resets, state, bytes(live) == original

    def test_partial_program_failure_recovers_before_reset(self):
        code, result, resets, state, preserved = self.exercise(baud=1500000)
        self.assertEqual(code, 1)  # recovery does not turn failed validation into a pass
        self.assertFalse(result["verified"])
        self.assertTrue(result["recovery_verified"])
        self.assertEqual(result["backup_baud"], 1500000)
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

    def test_without_apply_never_erases_and_resets_after_backup(self):
        code, result, resets, state, preserved = self.exercise(apply=False)
        self.assertEqual(code, 0)
        self.assertTrue(result["verified"])
        self.assertEqual(result["backup_baud"], 2000000)
        self.assertTrue(preserved)
        self.assertEqual(state["erases"], 0)
        self.assertEqual(resets, [(True, 0x2c)])

    def test_ignored_erase_cannot_pass_same_byte_validation(self):
        code, result, resets, state, preserved = self.exercise(ignore_erase=True)
        self.assertEqual(code, 1)
        self.assertFalse(result["verified"])
        self.assertEqual(result["runs"], [])
        self.assertIn("Sector did not become erased", result["errors"][0])
        self.assertTrue(preserved)
        self.assertEqual(resets, [(True, 0x2c)])


if __name__ == "__main__":
    unittest.main()
