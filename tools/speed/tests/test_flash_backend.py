"""Check preservation boundaries and failed-write behavior without hardware."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1]))
# Offline tests need no serial package; only its hardware caller uses it.
sys.modules.setdefault("serial", Mock())
from flash_backend import Flash, page_plan


class FlashTests(unittest.TestCase):
    def test_factory_and_unaligned_addresses_rejected_before_io(self):
        flash = Flash(None, None, None, allow_writes=True)
        flash.unlocked = True
        flash.spi = Mock()
        for address in (-4096, 1, 0x20000, 0x79000, 0x7e000):
            with self.assertRaises(ValueError):
                flash.write_sector(address, bytes(4096), expected_before=bytes(4096))
        flash.spi.assert_not_called()

    def test_pages_do_not_cross_boundaries_and_skip_erased_pages(self):
        data = b"\xff" * 256 + bytes(range(256)) * 15
        pages = page_plan(0x1f000, data)
        self.assertEqual(len(pages), 15)
        self.assertEqual(pages[0][0], 0x1f100)
        self.assertEqual(pages[-1][0], 0x1ff00)
        for address, page in pages:
            self.assertEqual(len(page), 256)
            self.assertEqual(address % 256, 0)

    def test_default_session_cannot_unlock_or_program(self):
        flash = Flash(None, None, None)
        flash.spi = Mock()
        with self.assertRaises(PermissionError): flash.unlock()
        with self.assertRaises(PermissionError):
            flash.write_sector(0, bytes(4096), expected_before=bytes(4096))
        flash.spi.assert_not_called()

    def test_raw_spi_cannot_bypass_write_policy(self):
        flash = Flash(None, None, None)
        flash.checked = Mock()
        for command in ([6], [0xc7], [0x20, 0, 0, 0], [2, 0, 0, 0, 1]):
            with self.assertRaises(PermissionError): flash.spi(command)
        flash.allow_writes = flash.unlocked = True
        for command in ([0xc7], [0x20, 7, 0xe0, 0], [2, 0, 0, 255, 1, 2]):
            with self.assertRaises(ValueError): flash.spi(command)
        flash.checked.assert_not_called()

    def test_live_backup_mismatch_prevents_erase(self):
        flash = Flash(None, None, None, allow_writes=True)
        flash.unlocked = True
        flash.read_sector = Mock(return_value=b"x" * 4096)
        flash.spi = Mock()
        with self.assertRaises(RuntimeError):
            flash.write_sector(4096, bytes(4096), expected_before=b"y" * 4096)
        flash.spi.assert_not_called()

    def test_program_readback_mismatch_is_an_error(self):
        flash = Flash(None, None, None, allow_writes=True)
        flash.unlocked = True
        flash.read_sector = Mock(side_effect=[b"\xff" * 4096, b"x" * 4096])
        flash.ready = Mock()
        flash.spi = Mock()
        with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
            flash.write_sector(4096, bytes(4096), expected_before=b"\xff" * 4096)

    def test_same_byte_rewrite_requires_explicit_flag_and_verifies(self):
        flash = Flash(None, None, None, allow_writes=True)
        flash.unlocked = True
        data = bytes(range(256)) * 16
        flash.read_sector = Mock(return_value=data)
        flash.ready = Mock()
        flash.spi = Mock()
        self.assertFalse(flash.write_sector(4096, data, expected_before=data))
        flash.spi.assert_not_called()
        self.assertTrue(flash.write_sector(4096, data, expected_before=data, force_rewrite=True))
        commands = [call.args[0] for call in flash.spi.call_args_list]
        self.assertEqual(sum(command[0] == 0x20 for command in commands), 1)
        self.assertEqual(sum(command[0] == 2 for command in commands), 16)
        self.assertEqual(flash.read_sector.call_count, 3)

    def test_force_rewrite_still_requires_matching_live_backup(self):
        flash = Flash(None, None, None, allow_writes=True)
        flash.unlocked = True
        flash.read_sector = Mock(return_value=b"x" * 4096)
        flash.spi = Mock()
        with self.assertRaisesRegex(RuntimeError, "Live sector differs"):
            flash.write_sector(4096, bytes(4096), expected_before=bytes(4096), force_rewrite=True)
        flash.spi.assert_not_called()

    def test_setup_failure_attempts_both_cleanup_steps(self):
        flash = Flash(None, None, None)
        flash.checked = Mock(side_effect=[RuntimeError("setup"), None, None])
        with self.assertRaisesRegex(RuntimeError, "setup"):
            flash.spi([5], 1)
        self.assertEqual(flash.checked.call_args_list[-2].args, (0x0d, [1]))
        self.assertEqual(flash.checked.call_args_list[-1].args, (0xb3, [0]))

    def test_busy_timeout_is_bounded(self):
        flash = Flash(None, None, None)
        flash.spi = Mock(return_value=b"\x01")
        with patch("flash_backend.time.monotonic", side_effect=[0, 0, 11]), patch("flash_backend.time.sleep"):
            with self.assertRaises(TimeoutError): flash.ready()


if __name__ == "__main__":
    unittest.main()
