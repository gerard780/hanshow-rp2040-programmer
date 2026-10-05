#!/usr/bin/env python3
"""Compare old and native flash-status reads without erase/unlock/program."""
import argparse
import importlib.util
import json
import time
from pathlib import Path
import hashlib
import serial
import usb.core
import benchmark_readback as bench
from flash_backend import Flash


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--reader", type=Path, required=True)
    p.add_argument("--port", required=True)
    p.add_argument("--bridge-serial", required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    if hashlib.sha256(args.reader.read_bytes()).hexdigest() != bench.READER_HASH:
        raise SystemExit("Unexpected reader")
    devices = [d for d in usb.core.find(find_all=True, idVendor=0xcafe, idProduct=0x4012)
               if d.serial_number == args.bridge_serial]
    if len(devices) != 1:
        raise SystemExit("Expected exactly one matching Zero")
    dev = devices[0]
    bench.select_825x_width(dev)
    spec = importlib.util.spec_from_file_location("reader", args.reader)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    args.output.mkdir(parents=True, exist_ok=False)
    before = bench.bridge_status(dev)
    result = {"verified": False, "baud": 3000000, "reads_per_path": 20}
    try:
        with serial.Serial(args.port, 3000000, timeout=.1, write_timeout=2) as port:
            flash = Flash(reader, port, dev)  # write-disabled session
            try:
                reader.activate(port, 3000)
                if not reader.set_sws_speed(port, 24000000):
                    raise RuntimeError("Divider check failed")
                if reader.sws_read_data(port, 0x7d, 3) != [2, 0x62, 0x55]:
                    raise RuntimeError("Unexpected chip")
                if flash.spi([0x9f], 3) != bytes.fromhex("eb6013"):
                    raise RuntimeError("Unexpected flash")
                values = []
                for mode in ("legacy", "native"):
                    start = time.monotonic()
                    data = []
                    for _ in range(result["reads_per_path"]):
                        if mode == "native":
                            data.append(flash.spi([5], 1)[0])
                        else:
                            try:
                                flash.checked(0xb3, [0x80]); flash.checked(0x0d, [0])
                                flash.checked(0x0c, [5, 0]); flash.checked(0x0d, [0x0a])
                                reply = reader.sws_read_data(port, 0x0c, 1)
                                if reply is None or len(reply) != 1:
                                    raise RuntimeError("Status read failed")
                                data.append(reply[0])
                            finally:
                                flash.checked(0x0d, [1]); flash.checked(0xb3, [0])
                    result[mode + "_seconds"] = time.monotonic() - start
                    values += data
                if len(set(values)) != 1:
                    raise RuntimeError("Status readings disagree")
                result["status_low"] = hex(values[0])
            finally:
                dev.ctrl_transfer(0x40, 0x12, 0, 0, b"")
                time.sleep(.06)
                reader.rd_wr_usbcom_blk(port, reader.sws_code_end())
                flash.checked(0x0d, [1]); flash.checked(0xb3, [0])
                result["reset_echo_verified"] = reader.rd_sws_wr_addr_usbcom(port, 0x6f, [0x22])
                port.flush(); time.sleep(.05)
        after = bench.bridge_status(dev)
        result["transport_faults"] = after["sws_faults"] - before["sws_faults"]
        result["reset_asserted"] = after["reset_asserted"]
        if result["transport_faults"] or result["reset_asserted"] or not result["reset_echo_verified"]:
            raise RuntimeError("Transport/reset check failed")
        result["speedup"] = result["legacy_seconds"] / result["native_seconds"]
        result["verified"] = True
    except Exception as error:
        result["error"] = str(error)
    finally:
        (args.output / "benchmark.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
