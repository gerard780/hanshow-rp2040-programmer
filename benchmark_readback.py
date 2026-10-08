#!/usr/bin/env python3
"""Time read-only flash backups using the legacy reader or Zero block capture."""
import argparse
import hashlib
import importlib.util
import json
import struct
import time
from pathlib import Path

import serial

READER_HASH = "2ea1b7c5266821e5d384a263daa7916bb4020fcdfb8f1ec0bed5842dcb94ca18"


def checked_write(reader, port, address, data):
    if not reader.rd_sws_wr_addr_usbcom(port, address, bytearray(data)):
        raise RuntimeError(f"SWS write echo failed at {address:#x}")


def block_read(reader, port, device, address, count):
    if not reader.rd_wr_usbcom_blk(port, reader.sws_rd_addr(address)):
        raise RuntimeError("SWS read header echo failed")
    completed_ok = False
    try:
        device.ctrl_transfer(0x40, 0x10, count, 0, b"", timeout=2000)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            response = bytes(device.ctrl_transfer(0xC0, 0x11, 0, 0, 8, timeout=2000))
            if len(response) < 8:
                raise RuntimeError("Incomplete block status")
            state, completed = struct.unpack_from("<II", response)
            if state == 2:
                if completed != count:
                    raise RuntimeError("Incomplete native block")
                data = bytes(device.ctrl_transfer(0xC0, 0x13, 0, 0, count, timeout=2000))
                if len(data) != count:
                    raise RuntimeError("Incomplete block payload")
                completed_ok = True
                return data
            if state == 3:
                raise RuntimeError(f"Native block failed after {completed} bytes")
            if state != 1:
                raise RuntimeError(f"Unexpected block state {state}")
            time.sleep(0.005)
        raise TimeoutError("Native block timed out")
    finally:
        # An interrupted request is bounded by the 50 ms native timeout.
        if not completed_ok:
            device.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
            time.sleep(0.06)
        if not reader.rd_wr_usbcom_blk(port, reader.sws_code_end()):
            raise RuntimeError("SWS stop echo failed")


def fast_flash_read(reader, port, device, stream, size):
    for offset in range(0, size, 4096):
        count = min(4096, size - offset)
        checked_write(reader, port, 0xB3, [0x80])
        checked_write(reader, port, 0x0D, [0])
        checked_write(reader, port, 0x0C,
                      [0x03, (offset >> 16) & 255, (offset >> 8) & 255, offset & 255, 0])
        checked_write(reader, port, 0x0D, [0x0A])
        data = block_read(reader, port, device, 0x0C, count)
        checked_write(reader, port, 0x0D, [1])
        checked_write(reader, port, 0xB3, [0])
        stream.write(data)
        if (offset + count) % 65536 == 0 or offset + count == size:
            print(f"Read {offset + count}/{size} bytes", flush=True)


def bridge_status(device):
    values = struct.unpack("<10I", bytes(device.ctrl_transfer(0xC0, 1, 0, 0, 40)))
    return {"version": f"{values[1] >> 16}.{values[1] & 65535}",
            "reset_asserted": bool(values[2] & 2), "sws_faults": values[7]}


def select_825x_width(device):
    # The known-chip tools use three-byte headers; restore them after a broad
    # reader session selected 826x. Older bench bridges have fixed framing.
    if bridge_status(device)["version"] in ("1.5", "1.6"):
        width = bytes(device.ctrl_transfer(0xC0, 0x21, 0, 0, 4, timeout=2000))
        if len(width) != 4 or struct.unpack("<I", width)[0] not in (2, 3):
            raise RuntimeError("Invalid SWS address-width response")
        if struct.unpack("<I", width)[0] == 3:
            return
        # v1.5 keeps SWS active across DTR transitions for legacy activation.
        # An unnecessary SET after a previous session stalls even when the
        # requested width is unchanged. Read first; change only if required.
        device.ctrl_transfer(0x40, 0x21, 3, 0, b"", timeout=2000)
        width = bytes(device.ctrl_transfer(0xC0, 0x21, 0, 0, 4, timeout=2000))
        if len(width) != 4 or struct.unpack("<I", width)[0] != 3:
            raise RuntimeError("SWS address width did not verify")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reader", type=Path, required=True)
    parser.add_argument("--port", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("legacy", "block"), default="legacy")
    parser.add_argument("--bridge-serial", help="Unique Zero ID, also checks transport faults")
    parser.add_argument("--size", type=int, default=524288)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--activation-ms", type=int, default=3000)
    parser.add_argument("--baud", type=int, default=2000000,
                        help="SWS command UART baud (default: 2000000; fallback: 1500000)")
    args = parser.parse_args()
    if not 1 <= args.size <= 524288 or not 1 <= args.runs <= 3:
        parser.error("Size must be 1..524288 and runs 1..3")
    if not 1 <= args.activation_ms <= 10000:
        parser.error("Activation must be 1..10000 ms")
    if not 340000 <= args.baud <= 3000000:
        parser.error("Baud must be 340000..3000000")
    if hashlib.sha256(args.reader.read_bytes()).hexdigest() != READER_HASH:
        raise SystemExit("Unexpected upstream reader hash")
    if args.mode == "block" and not args.bridge_serial:
        parser.error("Block mode requires --bridge-serial")
    device = None
    if args.bridge_serial:
        import usb.core
        devices = [d for d in usb.core.find(find_all=True, idVendor=0xCAFE, idProduct=0x4012)
                   if d.serial_number == args.bridge_serial]
        if len(devices) != 1:
            raise SystemExit("Expected exactly one matching Zero")
        device = devices[0]
        select_825x_width(device)
        if args.mode == "block" and bridge_status(device)["version"] not in ("1.1", "1.2", "1.3", "1.4", "1.5", "1.6"):
            raise SystemExit("Unsupported block-capture firmware")
    spec = importlib.util.spec_from_file_location("reader", args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    args.output.mkdir(parents=True, exist_ok=False)
    result = {"mode": args.mode, "port": args.port, "size": args.size,
              "reader_sha256": READER_HASH, "activation_ms": args.activation_ms, "baud": args.baud,
              "runs": [], "verified": False}
    try:
        for index in range(args.runs):
            run = {"file": f"flash-{index + 1}.bin"}
            result["runs"].append(run)
            started = time.monotonic()
            before = bridge_status(device) if device else None
            with serial.Serial(args.port, args.baud, timeout=0.1, write_timeout=2) as port:
                try:
                    reader.activate(port, args.activation_ms)
                    if not reader.set_sws_auto_speed(port):
                        raise RuntimeError("SWS calibration failed")
                    if not reader.set_sws_speed(port, 24000000):
                        raise RuntimeError("SWS clock divider check failed")
                    chip = reader.sws_read_data(port, 0x7D, 3)
                    if chip != [2, 0x62, 0x55]:
                        raise RuntimeError(f"Unexpected chip ID: {chip}")
                    run["chip_id"] = bytes(chip).hex()
                    checked_write(reader, port, 0xB3, [0x80])
                    checked_write(reader, port, 0x0D, [0])
                    checked_write(reader, port, 0x0C, [0x9F, 0])
                    checked_write(reader, port, 0x0D, [0x0A])
                    jedec = reader.sws_read_data(port, 0x0C, 3)
                    checked_write(reader, port, 0x0D, [1])
                    checked_write(reader, port, 0xB3, [0])
                    if jedec != [0xEB, 0x60, 0x13]:
                        raise RuntimeError(f"Unexpected flash ID: {jedec}")
                    run["jedec_id"] = bytes(jedec).hex()
                    reading = time.monotonic()
                    with (args.output / run["file"]).open("xb") as stream:
                        if args.mode == "block":
                            fast_flash_read(reader, port, device, stream, args.size)
                        elif not reader.FlashReadBlock(port, stream, 0, args.size):
                            raise RuntimeError("Legacy read failed")
                    run["read_seconds"] = time.monotonic() - reading
                finally:
                    if args.mode == "block":
                        device.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
                        time.sleep(0.06)
                    port.reset_input_buffer()
                    reader.rd_wr_usbcom_blk(port, reader.sws_code_end())
                    checked_write(reader, port, 0x0D, [1])
                    checked_write(reader, port, 0xB3, [0])
                    run["reset_echo_verified"] = reader.rd_sws_wr_addr_usbcom(port, 0x6F, [0x22])
                    port.flush()
                    time.sleep(0.05)
            run["total_seconds"] = time.monotonic() - started
            data = (args.output / run["file"]).read_bytes()
            if len(data) != args.size or data in (bytes(args.size), b"\xff" * args.size):
                raise RuntimeError("Incomplete or inconclusive flash read")
            run["sha256"] = hashlib.sha256(data).hexdigest()
            if device:
                after = bridge_status(device)
                run["transport_faults"] = after["sws_faults"] - before["sws_faults"]
                run["reset_asserted_at_finish"] = after["reset_asserted"]
                if run["transport_faults"] or after["reset_asserted"]:
                    raise RuntimeError("Bridge transport fault or reset still asserted")
            if not run["reset_echo_verified"]:
                raise RuntimeError("CPU reset echo failed")
            print(json.dumps(run, indent=2), flush=True)
        hashes = {run["sha256"] for run in result["runs"]}
        result["verified"] = len(hashes) == 1
        if not result["verified"]:
            raise RuntimeError("Repeated flash reads differ")
    except Exception as error:
        result["error"] = str(error)
    finally:
        (args.output / "benchmark.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
