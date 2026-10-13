"""Restore the application from a verified pre-install backup and browser report.

Uses conservative 64-byte programming at 921600 baud. Disconnect the GP2 reset
wire before opening the serial port: drivers can toggle control lines on open.
Factory bytes must still match; this tool never erases outside the application.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import struct
import time

import serial
import serial.tools.list_ports
import usb.core
import benchmark_readback as bench
from write_validation import ConservativeFlash, digest, full_snapshot, require

SIZE = 0x80000
LIMIT = 0x20000
SECTOR = 4096


def validate_source(report, backup):
    require(len(backup) == SIZE, "Recovery requires the original complete 512 KiB backup")
    require(backup[:LIMIT] not in (bytes(LIMIT), b"\xff" * LIMIT), "Original application is blank or inconclusive")
    require(report.get("apply") is True and report.get("verified") is False and
            report.get("cpuKeptHalted") is True, "Expected an interrupted browser-write report with CPU kept halted")
    require(report.get("chipId") == "026255" and report.get("jedecId") == "eb6013" and
            report.get("bridgeVersion") == "1.6", "Report is outside the tested recovery hardware")
    require(report.get("applicationBytes") == LIMIT, "Recovery supports the 128 KiB application region only")
    require(report.get("protectionOriginal") in (0x2c, 0x382c), "Unknown original protection layout")
    require(isinstance(report.get("flashUid"), str) and
            re.fullmatch(r"[0-9a-f]{32}", report["flashUid"]) is not None and
            report["flashUid"] not in ("00" * 16, "ff" * 16), "Invalid report flash UID")
    require(digest(backup) == report.get("backupSha256"), "Backup SHA256 differs from the report's original snapshot")


def recovery_order(original, current):
    require(len(original) == SIZE and len(current) == SIZE, "Incomplete recovery snapshots")
    require(current[LIMIT:] == original[LIMIT:], "Factory/identity/calibration bytes differ; recovery refuses to overwrite them")
    return [offset for offset in list(range(SECTOR, LIMIT, SECTOR)) + [0]
            if current[offset:offset + SECTOR] != original[offset:offset + SECTOR]]


def restore_sectors(flash, original, current, order, log):
    require(order == recovery_order(original, current), "Recovery order differs; sector zero must be last")
    for offset in order:
        log("sector_attempted", offset=offset)
        flash.begin_measurement()
        flash.rewrite_sector(offset, original[offset:offset + SECTOR], current[offset:offset + SECTOR])
        log("sector_verified", offset=offset)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backup", type=Path, required=True, help="Original complete 512 KiB pre-install backup")
    parser.add_argument("--report", type=Path, required=True, help="JSON report from the failed browser installation")
    parser.add_argument("--port", required=True, help="RP2040 SWS serial port (if00)")
    parser.add_argument("--bridge-serial", required=True)
    parser.add_argument("--output", type=Path, required=True, help="New private capture directory")
    parser.add_argument("--reset-wire-disconnected", action="store_true", required=True,
                        help="GP2 is physically disconnected from tag RST to prevent driver-open resets")
    parser.add_argument("--apply", action="store_true", help="Restore changed application sectors; default is read-only")
    args = parser.parse_args()
    original = args.backup.read_bytes()
    source = json.loads(args.report.read_text())
    validate_source(source, original)
    vendor = Path(__file__).resolve().parents[2] / "vendor/TLSR825xComFlasher.py"
    require(digest(vendor.read_bytes()) == bench.READER_HASH, "Unexpected vendor reader hash")
    devices = [d for d in usb.core.find(find_all=True, idVendor=0xcafe, idProduct=0x4012)
               if d.serial_number == args.bridge_serial]
    require(len(devices) == 1, "Expected exactly one matching RP2040")
    device = devices[0]
    ports = [p for p in serial.tools.list_ports.comports() if
             Path(p.device).resolve() == Path(args.port).resolve() and p.vid == 0xcafe and
             p.pid == 0x4012 and p.serial_number == args.bridge_serial]
    require(len(ports) == 1, "Serial port does not belong to selected RP2040")
    require(bench.bridge_status(device)["version"] == "1.6", "Recovery requires RP2040 v1.6")
    bench.select_825x_width(device)
    spec = importlib.util.spec_from_file_location("recovery_reader", vendor)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    args.output.mkdir(parents=True, exist_ok=False)
    result = {"apply": args.apply, "verified": False, "baud": 921600,
              "backup_sha256": digest(original), "cpu_halt_verified": False,
              "cpu_reset_attempted": False, "cpu_reset_verified": False, "events": []}

    def save_result():
        (args.output / "recovery-report.json").write_text(json.dumps(result, indent=2) + "\n")

    def log(event, **details):
        row = {"event": event, **details}
        result["events"].append(row)
        save_result()
        print(json.dumps(row), flush=True)

    # Configure inactive modem outputs before open, in addition to requiring
    # the physical reset wire disconnected. Never call activate with a reset.
    port = serial.Serial(baudrate=921600, timeout=.5, write_timeout=2)
    port.dtr = False
    port.rts = False
    port.port = args.port
    flash = None
    image_verified = False
    protection_verified = False
    failure = None
    try:
        port.open()
        before_tx = struct.unpack("<10I", bytes(device.ctrl_transfer(0xc0, 1, 0, 0, 40)))[6]
        port.reset_input_buffer()
        require(reader.rd_wr_usbcom_blk(port, reader.sws_code_end()), "SWS stop echo failed")
        time.sleep(.025)
        after_tx = struct.unpack("<10I", bytes(device.ctrl_transfer(0xc0, 1, 0, 0, 40)))[6]
        require((after_tx - before_tx) & 0xffffffff == 10, "Select the RP2040 SWS port, not Tag UART")
        # The interrupted tag may contain a mixed application. Halt directly;
        # the vendor activate() pulses RST and writes the reset register.
        require(reader.rd_sws_wr_addr_usbcom(port, 0x602, bytearray([5])), "CPU stop echo failed")
        require(reader.set_sws_auto_speed(port) and reader.set_sws_speed(port, 24000000), "SWS calibration failed")
        require(reader.sws_read_data(port, 0x7d, 3) == [2, 0x62, 0x55], "Unknown MCU")
        require(bench.block_read(reader, port, device, 0x602, 1) == b"\x05", "CPU halt did not verify")
        result["cpu_halt_verified"] = True
        flash = ConservativeFlash(reader, port, device, allow_writes=args.apply)
        require(flash.spi([0x9f], 3) == bytes.fromhex("eb6013"), "Unknown flash")
        expected_uid = bytes.fromhex(source["flashUid"])
        require(flash.spi([0x4b, 0, 0, 0, 0], 16) == expected_uid and
                flash.spi([0x4b, 0, 0, 0, 0], 16) == expected_uid, "Live flash UID differs from failed-install report")
        current, _ = full_snapshot(flash, args.output, "current-1.bin")
        second, _ = full_snapshot(flash, args.output, "current-2.bin")
        require(current == second, "Current full snapshots differ; recovery writes refused")
        order = recovery_order(original, current)
        result["planned_sectors"] = order
        log("recovery_plan_verified", sectors=order)
        if args.apply:
            flash.ready()
            protection = flash.status()
            expected_protection = source["protectionOriginal"]
            # WEL may remain set after the interrupted command. Other saved
            # non-protection bits must still agree; do not invent a layout.
            require((protection & ~0x407e) == (expected_protection & ~0x407e), "Live non-protection status bits differ")
            flash.protection = expected_protection
            flash._set_status(expected_protection & ~0x407c)
            flash.unlocked = True
            restore_sectors(flash, original, current, order, log)
            restored, _ = full_snapshot(flash, args.output, "restored.bin")
            require(restored == original, "Complete restored flash differs from original backup")
            image_verified = True
            log("full_original_image_verified", sha256=digest(restored))
            flash.restore_protection()
            require(flash.status() == expected_protection, "Original protection did not verify")
            protection_verified = True
            log("original_protection_verified", value=expected_protection)
            result["cpu_reset_attempted"] = True
            require(reader.rd_sws_wr_addr_usbcom(port, 0x6f, [0x22]), "CPU reset echo failed")
            result["cpu_reset_verified"] = True
            result["verified"] = True
            log("recovery_complete")
        else:
            result["check_passed"] = True
            log("read_only_check_complete_cpu_kept_halted")
    except BaseException as error:
        failure = error
        result["error"] = f"{type(error).__name__}: {error}"
        log("recovery_failed", message=result["error"])
    finally:
        # No reset after a failed restoration or a read-only check.
        if failure and flash is not None and flash.protection is not None and not protection_verified:
            try:
                device.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
                time.sleep(.06)
                port.reset_input_buffer()
                require(reader.rd_wr_usbcom_blk(port, reader.sws_code_end()), "Cleanup stop echo failed")
                flash.restore_protection()
                require(flash.status() == flash.protection, "Cleanup protection restore did not verify")
                protection_verified = True
            except BaseException as error:
                result["protection_error"] = f"{type(error).__name__}: {error}"
        result["image_verified"] = image_verified
        result["protection_verified"] = protection_verified
        result["cpu_kept_halted"] = result["cpu_halt_verified"] and not result["cpu_reset_attempted"]
        try:
            port.close()
        except BaseException as error:
            result["connection_cleanup_error"] = f"{type(error).__name__}: {error}"
        save_result()
    if failure:
        raise SystemExit(result["error"])
    return 0
