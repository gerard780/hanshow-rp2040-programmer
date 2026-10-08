"""Install a prepared 026255/EB6013 application plan; --apply enables writes.

Two fresh complete backups must match the offline plan. Writes stay below
0x20000, sector zero goes last, and CPU reset requires whole-flash verification
and restored protection. Per-tag backups and the recovery journal stay local.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import struct
import time
import zlib

import serial
import serial.tools.list_ports
import usb.core
import benchmark_readback as bench
from flash_backend import APPLICATION_LIMIT, Flash, SECTOR
from write_validation import (FLASH_BYTES, ConservativeFlash, MeasuredFlash,
                              digest, full_snapshot, require)


def load_plan(path):
    """Validate the offline package without accessing hardware."""
    meta = json.loads(path.read_text())
    padded = (path.parent / "application-padded.bin").read_bytes()
    expected = (path.parent / "expected-full-flash.bin").read_bytes()
    recovery = (path.parent / "recovery-application.bin").read_bytes()
    require(meta.get("hardware_access") is False and meta.get("write_start") == 0 and
            meta.get("sector_size") == SECTOR and meta.get("write_bytes") == len(padded) and
            meta.get("preserve_start") == len(padded) and meta.get("preserve_end") == FLASH_BYTES,
            "Unsupported application plan geometry")
    require(SECTOR <= len(padded) <= APPLICATION_LIMIT and len(padded) % SECTOR == 0,
            "Application must comprise full sectors below 0x20000")
    require(len(expected) == FLASH_BYTES and len(recovery) == len(padded), "Incomplete expected/recovery image")
    require(digest(expected) == meta.get("expected_full_flash_sha256") and
            expected[:len(padded)] == padded, "Expected image differs from application plan")
    require(padded[8:12] == b"KNLT", "Unknown application header")
    length = struct.unpack_from("<I", padded, 24)[0]
    require(32 <= length <= len(padded) and (length + SECTOR - 1) // SECTOR * SECTOR == len(padded),
            "Application header length differs from padding")
    firmware = padded[:length]
    require(digest(firmware) == meta.get("firmware_sha256") and
            struct.unpack_from("<I", firmware, length - 4)[0] == (zlib.crc32(firmware[:-4]) ^ 0xffffffff) and
            padded[length:] == b"\xff" * (len(padded) - length), "Application hash, checksum or padding invalid")
    return meta, padded, expected, recovery


def check_against_backup(plan, before):
    meta, padded, expected, recovery = plan
    require(len(before) == FLASH_BYTES and digest(before) == meta.get("backup_sha256"),
            "Fresh same-tag backup differs from prepared plan; writes refused")
    require(recovery == before[:len(padded)] and padded + before[len(padded):] == expected,
            "Plan changes preserved flash or recovery differs from same-tag backup")
    order = [off for off in list(range(SECTOR, len(padded), SECTOR)) + [0]
             if before[off:off + SECTOR] != expected[off:off + SECTOR]]
    require(meta.get("sectors_in_write_order") == order, "Plan sector order differs; sector zero must be last")
    return expected, order


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader", type=Path, default=Path(__file__).resolve().parents[2] / "vendor/TLSR825xComFlasher.py")
    parser.add_argument("--plan", type=Path, required=True, help="flash-plan.json from the application package prepare_flash.py")
    parser.add_argument("--port", required=True)
    parser.add_argument("--bridge-serial", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--baud", type=int, choices=(921600, 1500000, 2000000), default=2000000,
                        help="Fast-path baud (default: 2000000; fallback: 1500000)")
    args = parser.parse_args()
    plan = load_plan(args.plan)
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
    require(before["version"] in ("1.4", "1.5", "1.6"), "Installer requires bridge v1.4, v1.5 or v1.6")
    bench.select_825x_width(dev)
    args.output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("reader", args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    result = {"verified": False, "apply": args.apply, "bridge_serial": args.bridge_serial,
              "firmware_version": before["version"], "reader_sha256": bench.READER_HASH,
              "backup_baud": args.baud, "written_sectors": [], "cpu_reset_verified": False}

    def log(event, **details):
        row = {"event": event, **details}
        with (args.output / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(row) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        print(json.dumps(row), flush=True)

    original = None
    touched = []
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
                image_verified = True  # no flash mutation yet
                expected, order = check_against_backup(plan, original)
                result.update(snapshot_sha256=digest(original), backup_read_seconds=[seconds, second_seconds],
                              expected_sha256=digest(expected), planned_sectors=[hex(x) for x in order])
                log("plan_verified_against_two_full_backups", sha256=digest(original), sectors=len(order))
                if args.apply and order:
                    require(flash.spi([0x4b, 0, 0, 0, 0], 16) == uid, "Identity changed before unlock")
                    image_verified = False
                    flash.unlock()
                    for offset in order:
                        require(bench.block_read(reader, port, dev, 0x602, 1) == b"\x05", "CPU no longer halted")
                        flash.begin_measurement()
                        touched.append(offset)  # recovery includes a partially erased/programmed sector
                        flash.write_sector(offset, expected[offset:offset + SECTOR],
                                           expected_before=original[offset:offset + SECTOR])
                        result["written_sectors"].append(hex(offset))
                        log("sector_written_and_verified", sector=hex(offset))
                    after, seconds = full_snapshot(flash, args.output, "after.bin")
                    require(after == expected, "Complete programmed flash differs from prepared plan")
                    result.update(after_sha256=digest(after), full_flash_equal_expected=True,
                                  post_write_read_seconds=seconds)
                    image_verified = True
                    log("complete_image_verified", sha256=digest(after))
                elif args.apply:
                    result["already_installed"] = True
                    log("image_already_matches_no_writes_needed")
            except BaseException as error:
                errors.append(f"installation: {type(error).__name__}: {error}")
                log("installation_failed", error=errors[-1])
                if touched and original is not None:
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
                        for offset in sorted(set(touched) - {0}) + ([0] if 0 in touched else []):
                            recovery.begin_measurement()
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
    except BaseException as error:
        errors.append(f"session: {type(error).__name__}: {error}")
    finally:
        if errors:
            result["errors"] = errors
        (args.output / "application-install.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
