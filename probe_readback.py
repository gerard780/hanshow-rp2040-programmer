#!/usr/bin/env python3
"""Read chip ID and two flash samples, always attempting CPU reset afterward.

Uses the exact upstream reader from our previous successful CH340 sessions.
No flash erase, program, or unlock routine is called.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import time
from pathlib import Path

import serial

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--reader", type=Path, required=True)
parser.add_argument("--port", required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--activation-ms", type=int, default=3000)
parser.add_argument("--sample-size", type=int, default=256,
                    help="Bytes to read twice from flash address zero (256..4096)")
args = parser.parse_args()
expected_hash = "2ea1b7c5266821e5d384a263daa7916bb4020fcdfb8f1ec0bed5842dcb94ca18"
if hashlib.sha256(args.reader.read_bytes()).hexdigest() != expected_hash:
    raise SystemExit("Reader hash differs from the version previously tested")
if not 1 <= args.activation_ms <= 10000:
    raise SystemExit("Activation must be between 1 and 10000 ms")
if not 256 <= args.sample_size <= 4096:
    raise SystemExit("Sample size must be between 256 and 4096 bytes")
args.output.mkdir(parents=True, exist_ok=False)
spec = importlib.util.spec_from_file_location("sws_reader", args.reader)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
reader.debug = True
result = {"port": args.port, "baud": 921600, "activation_ms": args.activation_ms,
          "sample_size": args.sample_size, "reader_sha256": expected_hash, "verified": False}
try:
    with serial.Serial(args.port, 921600, timeout=0.1, write_timeout=2) as port:
        try:
            port.reset_input_buffer()
            reader.activate(port, args.activation_ms)
            if not reader.set_sws_auto_speed(port):
                raise RuntimeError("SWS clock calibration failed")
            # Native pulse decoding accepts faster replies than the old UART
            # decoder. Keep this known 24 MHz tag near the previously tested
            # 92 kbit/s SWS rate rather than accepting the first (fastest) divider.
            if not reader.set_sws_speed(port, 24000000):
                raise RuntimeError("Could not select the previously tested SWS rate")
            chip = reader.sws_read_data(port, 0x7D, 3)
            if chip is None or len(chip) != 3:
                raise RuntimeError("Chip ID read failed")
            result["chip_id_bytes"] = bytes(chip).hex()
            print("Chip ID:", result["chip_id_bytes"], flush=True)
            if bytes(chip)[1:] != b"\x62\x55":
                raise RuntimeError("Chip ID differs from the previously identified 0x5562 family")
            reader.rd_sws_wr_addr_usbcom(port, 0x0B3, bytearray([0x80]))
            reader.rd_sws_wr_addr_usbcom(port, 0x0D, bytearray([0x00]))
            reader.rd_sws_wr_addr_usbcom(port, 0x0C, bytearray([0x9F, 0x00]))
            reader.rd_sws_wr_addr_usbcom(port, 0x0D, bytearray([0x0A]))
            jedec = reader.sws_read_data(port, 0x0C, 3)
            reader.rd_sws_wr_addr_usbcom(port, 0x0D, bytearray([0x01]))
            reader.rd_sws_wr_addr_usbcom(port, 0x0B3, bytearray([0x00]))
            if jedec is None:
                raise RuntimeError("Flash identification read failed")
            result["jedec_id"] = bytes(jedec).hex()
            print("Flash JEDEC ID:", result["jedec_id"], flush=True)
            if bytes(jedec) != b"\xeb\x60\x13":
                raise RuntimeError("Flash ID differs from the previously identified 512 KiB flash")
            samples = []
            for label in ("a", "b"):
                stream = io.BytesIO()
                if not reader.FlashReadBlock(port, stream, 0, args.sample_size):
                    raise RuntimeError(f"Flash sample {label} failed")
                data = stream.getvalue()
                if len(data) != args.sample_size:
                    raise RuntimeError("Incomplete flash sample")
                (args.output / f"sample-{label}.bin").write_bytes(data)
                samples.append(data)
                print(f"Sample {label} SHA256:", hashlib.sha256(data).hexdigest(), flush=True)
            if samples[0] != samples[1]:
                raise RuntimeError("Independent flash samples differ")
            if samples[0] in (bytes(args.sample_size), bytes([255]) * args.sample_size):
                raise RuntimeError("Sample is entirely 00 or FF; inconclusive readback")
            if samples[0][8:12] != b"KNLT":
                raise RuntimeError("Sample does not contain the expected Telink image signature")
            result["sample_sha256"] = hashlib.sha256(samples[0]).hexdigest()
            result["verified"] = True
        finally:
            # End a partial SWS transaction before attempting software reset.
            port.reset_input_buffer()
            reader.rd_wr_usbcom_blk(port, reader.sws_code_end())
            result["reset_echo_verified"] = reader.rd_sws_wr_addr_usbcom(port, 0x006F, bytearray([0x22]))
            port.flush()
            time.sleep(0.05)
            print("CPU reset command sent; echo verified:", result["reset_echo_verified"], flush=True)
except Exception as error:
    result["error"] = str(error)
finally:
    (args.output / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)
if not result["verified"]:
    raise SystemExit(1)
