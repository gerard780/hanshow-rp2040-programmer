#!/usr/bin/env python3
"""Read-only cancellation/legacy/native validation against an existing backup."""
import argparse
import importlib.util
import io
import json
import struct
import time
from pathlib import Path

import serial
import usb.core
import benchmark_readback as bench


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--reader", type=Path, required=True)
    p.add_argument("--reference", type=Path, required=True)
    p.add_argument("--port", required=True)
    p.add_argument("--bridge-serial", required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    import hashlib
    if hashlib.sha256(args.reader.read_bytes()).hexdigest() != bench.READER_HASH:
        raise SystemExit("Unexpected reader source")
    reference = args.reference.read_bytes()
    if len(reference) != 524288:
        raise SystemExit("Expected a complete reference dump")
    devices = [d for d in usb.core.find(find_all=True, idVendor=0xcafe, idProduct=0x4012)
               if d.serial_number == args.bridge_serial]
    if len(devices) != 1:
        raise SystemExit("Expected exactly one matching Zero")
    dev = devices[0]
    bench.select_825x_width(dev)
    spec = importlib.util.spec_from_file_location("reader", args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    before = bench.bridge_status(dev)
    result = {"verified": False, "reference_sha256": hashlib.sha256(reference).hexdigest()}
    args.output.mkdir(parents=True, exist_ok=False)

    def rejected(count, index):
        try:
            dev.ctrl_transfer(0x40, 0x10, count, index, b"", timeout=2000)
        except usb.core.USBError as error:
            if error.errno != 32:
                raise
            return
        raise RuntimeError("Invalid or concurrent request accepted")

    try:
        for count, index in [(0, 0), (4097, 0), (1, 1)]:
            rejected(count, index)
        result["invalid_requests_rejected"] = True
        with serial.Serial(args.port, 921600, timeout=.1, write_timeout=2) as port:
            try:
                reader.activate(port, 3000)
                if not reader.set_sws_speed(port, 24000000):
                    raise RuntimeError("Divider check failed")
                dev.ctrl_transfer(0x40, 0x10, 1, 0, b"")
                time.sleep(.01)
                if struct.unpack("<II", bytes(dev.ctrl_transfer(0xc0, 0x11, 0, 0, 8))) != (3, 0):
                    raise RuntimeError("Missing read header accepted")
                result["missing_header_rejected"] = True
                for address, data in [(0xb3, [0x80]), (0x0d, [0]),
                                      (0x0c, [3, 0, 0, 0, 0]), (0x0d, [0x0a])]:
                    bench.checked_write(reader, port, address, data)
                if not reader.rd_wr_usbcom_blk(port, reader.sws_rd_addr(0x0c)):
                    raise RuntimeError("Header echo failed")
                dev.ctrl_transfer(0x40, 0x10, 4096, 0, b"")
                rejected(1, 0)
                result["concurrent_start_rejected"] = True
                time.sleep(.02)
                dev.ctrl_transfer(0x40, 0x12, 0, 0, b"")
                time.sleep(.06)
                state, count = struct.unpack("<II", bytes(dev.ctrl_transfer(0xc0, 0x11, 0, 0, 8)))
                if state != 3 or not 0 < count < 4096:
                    raise RuntimeError(f"Cancellation failed: {state}, {count}")
                if bytes(dev.ctrl_transfer(0xc0, 0x13, 0, 0, count)) != reference[:count]:
                    raise RuntimeError("Cancelled payload differs")
                result["cancel_partial_bytes"] = count
                if not reader.rd_wr_usbcom_blk(port, reader.sws_code_end()):
                    raise RuntimeError("Stop echo after cancellation failed")
                bench.checked_write(reader, port, 0x0d, [1])
                bench.checked_write(reader, port, 0xb3, [0])
                for size in [1, 4096, 4137]:
                    stream = io.BytesIO()
                    bench.fast_flash_read(reader, port, dev, stream, size)
                    if stream.getvalue() != reference[:size]:
                        raise RuntimeError(f"Native read mismatch: {size}")
                result["native_reads_after_cancel_match"] = True
                stream = io.BytesIO()
                if not reader.FlashReadBlock(port, stream, 0, 4096) or stream.getvalue() != reference[:4096]:
                    raise RuntimeError("Legacy read mismatch")
                result["legacy_4096_matches"] = True
            finally:
                dev.ctrl_transfer(0x40, 0x12, 0, 0, b"")
                time.sleep(.06)
                port.reset_input_buffer()
                reader.rd_wr_usbcom_blk(port, reader.sws_code_end())
                bench.checked_write(reader, port, 0x0d, [1])
                bench.checked_write(reader, port, 0xb3, [0])
                result["reset_echo_verified"] = reader.rd_sws_wr_addr_usbcom(port, 0x6f, [0x22])
                port.flush()
                time.sleep(.05)
        after = bench.bridge_status(dev)
        result["transport_faults"] = after["sws_faults"] - before["sws_faults"]
        result["reset_asserted"] = after["reset_asserted"]
        if result["transport_faults"] or result["reset_asserted"] or not result["reset_echo_verified"]:
            raise RuntimeError("Transport/reset check failed")
        result["verified"] = True
    except Exception as error:
        result["error"] = str(error)
    finally:
        (args.output / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
