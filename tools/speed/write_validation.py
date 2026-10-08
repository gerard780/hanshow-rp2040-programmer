#!/usr/bin/env python3
"""Validate same-byte sector rewrites on a backed-up tag; --apply enables writes.

This is a bench test, not an installer. Sector zero and upper flash are excluded.
Two durable, identical full snapshots precede unlock. Failed writes recover the
selected sector with the conservative 64-byte path at 921600, and CPU reset is
allowed only after full-flash equality and exact protection restoration.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import time

import serial
import serial.tools.list_ports
import usb.core
import benchmark_readback as bench
from flash_backend import APPLICATION_LIMIT, Flash, PAGE, SECTOR, page_plan

FLASH_BYTES = 524288


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, data):
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


class MeasuredFlash(Flash):
    def begin_measurement(self):
        self.metrics = {"erase_seconds": 0, "program_seconds": 0,
                        "write_enable_seconds": 0, "pages": 0, "program_bytes": 0,
                        "sector_reads_seconds": []}
        self.pending = None

    def spi(self, command, count=0):
        started = time.monotonic()
        response = super().spi(command, count)
        if hasattr(self, "metrics") and command[0] in (2, 6, 0x20):
            key = {2: "program_seconds", 6: "write_enable_seconds", 0x20: "erase_seconds"}[command[0]]
            self.metrics[key] += time.monotonic() - started
            if command[0] != 6:
                self.pending = key
            if command[0] == 0x20:
                self.erase_address = int.from_bytes(bytes(command[1:4]), "big")
            if command[0] == 2:
                self.metrics["pages"] += 1
                self.metrics["program_bytes"] += len(command) - 4
        return response

    def ready(self, timeout=10):
        started = time.monotonic()
        super().ready(timeout)
        self.complete_ready(started)

    def complete_ready(self, started):
        phase = getattr(self, "pending", None)
        if phase:
            self.metrics[phase] += time.monotonic() - started
            self.pending = None
        if phase == "erase_seconds":
            require(self.read_sector(self.erase_address) == b"\xff" * SECTOR,
                    "Sector did not become erased; programming refused")
            self.metrics["erased_sector_verified"] = True

    def read_sector(self, offset):
        started = time.monotonic()
        data = super().read_sector(offset)
        if hasattr(self, "metrics"):
            self.metrics["sector_reads_seconds"].append(time.monotonic() - started)
        return data


class ConservativeFlash(MeasuredFlash):
    """Same 64-byte programs and legacy status reads used by the old Zero writer."""
    def ready(self, timeout=10):
        started = time.monotonic()
        deadline = started + timeout
        while time.monotonic() < deadline:
            try:
                self.checked(0xb3, [0x80])
                self.checked(0x0d, [0])
                self.checked(0x0c, [5, 0])
                self.checked(0x0d, [0x0a])
                reply = self.reader.sws_read_data(self.port, 0x0c, 1)
                require(reply is not None and len(reply) == 1, "Legacy status failed")
            finally:
                try:
                    self.checked(0x0d, [1])
                finally:
                    self.checked(0xb3, [0])
            if not reply[0] & 1:
                self.complete_ready(started)
                return
        raise TimeoutError("Legacy flash remained busy")

    def rewrite_sector(self, offset, data, expected_before):
        page_plan(offset, data)  # same region and complete-sector checks
        require(self.allow_writes and self.unlocked, "Unlocked write session required")
        require(len(expected_before) == SECTOR and self.read_sector(offset) == expected_before,
                "Conservative path live sector differs from saved contents")
        self.spi([6])
        self.spi([0x20, offset >> 16, (offset >> 8) & 255, offset & 255])
        self.ready()
        for start in range(0, SECTOR, 64):
            part = data[start:start + 64]
            if part == b"\xff" * 64:
                continue
            address = offset + start
            self.spi([6])
            self.spi([2, address >> 16, (address >> 8) & 255, address & 255] + list(part))
            self.ready()
        require(self.read_sector(offset) == data, "Conservative sector readback mismatch")


def full_snapshot(flash, output, name):
    data = bytearray()
    started = time.monotonic()
    for offset in range(0, FLASH_BYTES, SECTOR):
        data += flash.read_sector(offset)
        if len(data) % 65536 == 0:
            print(f"{name}: {len(data)}/{FLASH_BYTES}", flush=True)
    save(output / name, data)
    return bytes(data), time.monotonic() - started


def select_sector(snapshot):
    length = struct.unpack_from("<I", snapshot, 24)[0]
    require(2 * SECTOR <= length <= APPLICATION_LIMIT, "Unknown application length")
    candidates = []
    for offset in range(SECTOR, length // SECTOR * SECTOR, SECTOR):
        data = snapshot[offset:offset + SECTOR]
        pages = page_plan(offset, data)
        candidates.append((sum(byte != 255 for byte in data), len(pages), -offset))
    require(bool(candidates), "No complete nonzero application sector")
    _, pages, negative_offset = max(candidates)
    require(pages == SECTOR // PAGE, "Need a populated sector for full-page validation")
    return -negative_offset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader", type=Path, required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--bridge-serial", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--baud", type=int, choices=(921600, 1500000, 2000000, 3000000), default=2000000,
                        help="Fast-path baud (default: 2000000; fallback: 1500000)")
    args = parser.parse_args()
    require(digest(args.reader.read_bytes()) == bench.READER_HASH, "Unexpected reader hash")
    devices = [d for d in usb.core.find(find_all=True, idVendor=0xcafe, idProduct=0x4012)
               if d.serial_number == args.bridge_serial]
    require(len(devices) == 1, "Expected exactly one matching Zero")
    dev = devices[0]
    ports = [port for port in serial.tools.list_ports.comports()
             if Path(port.device).resolve() == Path(args.port).resolve()
             and port.vid == 0xcafe and port.pid == 0x4012
             and port.serial_number == args.bridge_serial]
    require(len(ports) == 1, "Serial port does not belong to selected Zero")
    before = bench.bridge_status(dev)
    require(before["version"] in ("1.4", "1.5", "1.6"), "Validation requires bridge v1.4, v1.5 or v1.6")
    bench.select_825x_width(dev)
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("reader", args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    result = {"verified": False, "apply": args.apply, "bridge_serial": args.bridge_serial,
              "firmware_version": before["version"], "reader_sha256": bench.READER_HASH,
              "backup_baud": args.baud, "runs": [], "cpu_reset_verified": False}

    def log(event, **details):
        row = {"event": event, **details}
        with (args.output / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(row) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps(row), flush=True)

    original = None
    offset = None
    touched = False
    image_verified = False
    errors = []
    try:
        with serial.Serial(args.port, args.baud, timeout=.1, write_timeout=2, exclusive=True) as port:
            flash = MeasuredFlash(reader, port, dev, allow_writes=args.apply)
            try:
                reader.activate(port, 3000)
                require(reader.set_sws_auto_speed(port) and reader.set_sws_speed(port, 24000000),
                        "SWS calibration failed")
                require(reader.sws_read_data(port, 0x7d, 3) == [2, 0x62, 0x55], "Unknown MCU")
                require(bench.block_read(reader, port, dev, 0x602, 1) == b"\x05", "CPU halt did not verify")
                require(flash.spi([0x9f], 3) == bytes.fromhex("eb6013"), "Unknown flash")
                uid = flash.spi([0x4b, 0, 0, 0, 0], 16)
                require(uid not in (bytes(16), b"\xff" * 16) and
                        uid == flash.spi([0x4b, 0, 0, 0, 0], 16), "Flash UID did not repeat")
                protection = flash.status()
                require(protection in (0x2c, 0x382c), "Unknown protection layout")
                result.update(chip_id="026255", jedec_id="eb6013", flash_uid=uid.hex(),
                              protection_original=hex(protection))
                log("identity_verified", **{k: result[k] for k in
                                            ("chip_id", "jedec_id", "flash_uid", "protection_original")})
                original, seconds = full_snapshot(flash, args.output, "before-1.bin")
                second, second_seconds = full_snapshot(flash, args.output, "before-2.bin")
                require(original == second, "Fresh full snapshots differ; writes refused")
                require(original not in (bytes(FLASH_BYTES), b"\xff" * FLASH_BYTES), "Inconclusive snapshot")
                offset = select_sector(original)
                data = original[offset:offset + SECTOR]
                result.update(snapshot_sha256=digest(original), backup_read_seconds=[seconds, second_seconds],
                              sector_offset=hex(offset), sector_bytes=SECTOR, sector_sha256=digest(data))
                log("two_full_snapshots_verified", sha256=digest(original), sector=hex(offset))
                image_verified = True
                if args.apply:
                    require(flash.spi([0x4b, 0, 0, 0, 0], 16) == uid, "Identity changed before unlock")
                    image_verified = False  # restoration required from first status mutation onward
                    flash.unlock()
                    for mode, baud in (("conservative-64-legacy-status", 921600),
                                       ("fast-256-native-status", args.baud),
                                       ("fast-256-native-status", args.baud)):
                        port.baudrate = baud
                        port.reset_input_buffer()
                        require(reader.set_sws_speed(port, 24000000), "Baud switch check failed")
                        require(bench.block_read(reader, port, dev, 0x602, 1) == b"\x05", "CPU no longer halted")
                        current = (ConservativeFlash(reader, port, dev, allow_writes=True)
                                   if mode.startswith("conservative") else flash)
                        current.unlocked = True
                        current.begin_measurement()
                        touched = True  # include a partial erase/program in recovery
                        start = time.monotonic()
                        if isinstance(current, ConservativeFlash):
                            current.rewrite_sector(offset, data, data)
                        else:
                            require(current.write_sector(offset, data, expected_before=data, force_rewrite=True),
                                    "No physical rewrite occurred")
                        elapsed = time.monotonic() - start
                        metrics = dict(current.metrics)
                        reads = metrics.pop("sector_reads_seconds")
                        require(len(reads) == 3, "Expected pre-write, erased and post-write reads")
                        metrics.update(mode=mode, baud=baud, total_seconds=elapsed,
                                       precheck_seconds=reads[0], erased_check_seconds=reads[1],
                                       verify_seconds=reads[2],
                                       sector_verified=True)
                        result["runs"].append(metrics)
                        log("sector_rewrite_verified", **metrics)
                    after, seconds = full_snapshot(flash, args.output, "after.bin")
                    require(after == original, "Full flash changed after same-byte rewrites")
                    result.update(after_sha256=digest(after), full_flash_equal=True,
                                  post_write_read_seconds=seconds)
                    image_verified = True
                    log("full_flash_preserved", sha256=digest(after))
            except BaseException as error:
                errors.append(f"validation: {type(error).__name__}: {error}")
                log("validation_failed", error=errors[-1])
                if touched and original is not None and offset is not None:
                    try:
                        dev.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
                        time.sleep(.06)
                        port.reset_input_buffer()
                        reader.rd_wr_usbcom_blk(port, reader.sws_code_end())
                        port.baudrate = 921600
                        port.reset_input_buffer()
                        require(reader.set_sws_speed(port, 24000000), "Recovery baud check failed")
                        require(flash.spi([0x4b, 0, 0, 0, 0], 16) == uid, "Recovery target changed")
                        recovery = ConservativeFlash(reader, port, dev, allow_writes=True)
                        recovery.unlocked = True
                        live = recovery.read_sector(offset)
                        recovery.rewrite_sector(offset, original[offset:offset + SECTOR], live)
                        restored, _ = full_snapshot(recovery, args.output, "recovered.bin")
                        require(restored == original, "Full recovery verification failed")
                        image_verified = True
                        result["recovery_verified"] = True
                        log("full_recovery_verified", sha256=digest(restored))
                    except BaseException as recovery_error:
                        image_verified = False
                        errors.append(f"recovery: {type(recovery_error).__name__}: {recovery_error}")
                        log("recovery_required", error=errors[-1])
                elif original is not None and not touched:
                    # No erase/program attempted; only protection could have changed.
                    image_verified = True
            finally:
                protection_verified = flash.protection is None
                if flash.protection is not None:
                    try:
                        flash.restore_protection()
                        result["protection_final"] = hex(flash.status())
                        require(flash.status() == flash.protection, "Protection restore did not repeat")
                        protection_verified = True
                        log("protection_restored", status=result["protection_final"])
                    except BaseException as error:
                        errors.append(f"protection: {type(error).__name__}: {error}")
                        log("protection_restore_failed", error=errors[-1])
                try:
                    dev.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
                    time.sleep(.06)
                    port.reset_input_buffer()
                    require(reader.rd_wr_usbcom_blk(port, reader.sws_code_end()), "Stop echo failed")
                    flash.checked(0x0d, [1])
                    flash.checked(0xb3, [0])
                    if image_verified and protection_verified:
                        result["cpu_reset_verified"] = bool(reader.rd_sws_wr_addr_usbcom(port, 0x6f, [0x22]))
                        require(result["cpu_reset_verified"], "CPU reset echo failed")
                        port.flush()
                        time.sleep(.05)
                        log("cpu_reset_verified")
                    else:
                        log("cpu_kept_halted_for_recovery")
                except BaseException as error:
                    errors.append(f"cleanup: {type(error).__name__}: {error}")
                    log("cleanup_failed", error=errors[-1])
        after_status = bench.bridge_status(dev)
        result["transport_faults"] = after_status["sws_faults"] - before["sws_faults"]
        result["reset_asserted_at_finish"] = after_status["reset_asserted"]
        require(result["transport_faults"] == 0 and not after_status["reset_asserted"],
                "Bridge transport/reset check failed")
        result["verified"] = not errors and image_verified and result["cpu_reset_verified"]
        if args.apply and result["verified"]:
            baseline = result["runs"][0]["total_seconds"]
            result["sector_speedup"] = [baseline / run["total_seconds"] for run in result["runs"][1:]]
    except BaseException as error:
        errors.append(f"session: {type(error).__name__}: {error}")
    finally:
        if errors:
            result["errors"] = errors
        (args.output / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
