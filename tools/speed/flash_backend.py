"""Experimental host flash backend: 256-byte pages and native status reads.

Writes are disabled by default. A caller enabling them must own the complete
backup, verify target identity, write sector zero last, and keep the CPU halted
until the image and restored protection verify. This module never resets CPU.
The sector programmer passed repeated same-byte hardware rewrites of one 4 KiB
application sector on one 026255 / eb6013 tag; full-image installation is untested.
"""
import time
import benchmark_readback as bench

SECTOR = 4096
PAGE = 256
APPLICATION_LIMIT = 0x20000


def page_plan(offset, data):
    if not isinstance(offset, int) or offset < 0 or offset % SECTOR or offset + SECTOR > APPLICATION_LIMIT:
        raise ValueError("Sector lies outside the known application region")
    if len(data) != SECTOR:
        raise ValueError("Expected exactly one full sector")
    return [(offset + start, bytes(data[start:start + PAGE]))
            for start in range(0, SECTOR, PAGE)
            if data[start:start + PAGE] != b"\xff" * PAGE]


class Flash:
    def __init__(self, reader, port, device, *, allow_writes=False):
        self.reader, self.port, self.device = reader, port, device
        self.allow_writes = allow_writes
        self.protection = None
        self.unlocked = False

    def checked(self, address, data):
        bench.checked_write(self.reader, self.port, address, data)

    def spi(self, command, count=0):
        command = bytes(command)
        if not command:
            raise ValueError("Missing SPI opcode")
        opcode = command[0]
        if opcode not in (3, 5, 0x35, 0x9f, 0x4b):
            if not self.allow_writes:
                raise PermissionError("Flash writes are disabled")
            if opcode not in (1, 2, 6, 0x20):
                raise ValueError("SPI opcode outside the experimental application policy")
            if opcode in (2, 0x20):
                if not self.unlocked:
                    raise PermissionError("Unlocked session required")
                address = int.from_bytes(command[1:4], "big")
                if opcode == 0x20:
                    if len(command) != 4 or address % SECTOR or address + SECTOR > APPLICATION_LIMIT:
                        raise ValueError("Erase outside application policy")
                elif not 5 <= len(command) <= 260 or address >= APPLICATION_LIMIT or (address % PAGE) + len(command) - 4 > PAGE:
                    raise ValueError("Page program outside application policy or page boundary")
        if not 0 <= count <= SECTOR:
            raise ValueError("SPI capture count outside block capacity")
        # Enter try before setup so even a failed setup gets a cleanup attempt.
        try:
            self.checked(0xb3, [0x80])
            self.checked(0x0d, [0])
            self.checked(0x0c, list(command) + ([0] if count else []))
            if count:
                self.checked(0x0d, [0x0a])
                return bench.block_read(self.reader, self.port, self.device, 0x0c, count)
            return b""
        finally:
            try:
                self.checked(0x0d, [1])
            finally:
                self.checked(0xb3, [0])

    def status(self):
        return self.spi([5], 1)[0] | self.spi([0x35], 1)[0] << 8

    def ready(self, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.spi([5], 1)[0] & 1:
                return
            time.sleep(.001)
        raise TimeoutError("Flash remained busy")

    def read_sector(self, offset):
        if not isinstance(offset, int) or offset < 0 or offset % SECTOR or offset + SECTOR > 524288:
            raise ValueError("Read outside main-flash sector boundaries")
        return self.spi([3, offset >> 16, (offset >> 8) & 255, offset & 255], SECTOR)

    def _set_status(self, value):
        if not self.allow_writes:
            raise PermissionError("Flash writes are disabled")
        if self.protection is None or value not in (self.protection, self.protection & ~0x407c):
            raise ValueError("Status write must retain the saved non-protection bits")
        self.spi([6])
        self.spi([1, value & 255, value >> 8])
        self.ready()
        if self.status() != value:
            raise RuntimeError("Protection status did not verify")

    def unlock(self):
        if not self.allow_writes:
            raise PermissionError("Flash writes are disabled")
        if self.protection is not None:
            raise RuntimeError("Session already saved a protection value")
        value = self.status()
        if value not in (0x2c, 0x382c):
            raise RuntimeError("Unknown protection layout")
        # Save before a potentially partial mutation, allowing caller recovery.
        self.protection = value
        self._set_status(value & ~0x407c)
        self.unlocked = True

    def restore_protection(self):
        if self.protection is not None:
            self.unlocked = False
            self._set_status(self.protection)

    def write_sector(self, offset, data, *, expected_before, force_rewrite=False):
        """Program and verify a sector; force_rewrite permits same-byte bench tests."""
        pages = page_plan(offset, data)
        if len(expected_before) != SECTOR:
            raise ValueError("Expected a complete saved pre-write sector")
        if not self.allow_writes or not self.unlocked:
            raise PermissionError("Explicitly authorized, unlocked session required")
        if self.read_sector(offset) != expected_before:
            raise RuntimeError("Live sector differs from saved pre-write contents")
        if data == expected_before and not force_rewrite:
            return False
        self.spi([6])
        self.spi([0x20, offset >> 16, (offset >> 8) & 255, offset & 255])
        self.ready()
        for address, page in pages:
            self.spi([6])
            self.spi([2, address >> 16, (address >> 8) & 255, address & 255] + list(page))
            self.ready()
        if self.read_sector(offset) != data:
            raise RuntimeError("Programmed sector readback mismatch; keep CPU halted")
        return True
