#!/usr/bin/env python3
"""Read bridge diagnostics, or explicitly return the Zero to USB boot mode."""
import argparse
import json
import struct
import usb.core

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--boot", action="store_true", help="Return the Zero to BOOTSEL for updating")
args = parser.parse_args()
devices = list(usb.core.find(find_all=True, idVendor=0xCAFE, idProduct=0x4012))
if len(devices) != 1:
    raise SystemExit(f"Expected exactly one Hanshow bridge; found {len(devices)}")
device = devices[0]
reply = bytes(device.ctrl_transfer(0xC0, 0x01, 0, 0, 40, timeout=2000))
if len(reply) != 40:
    raise SystemExit("Incomplete bridge status")
magic, version, flags, sws_baud, uart_baud, sws_rx, sws_tx, sws_drops, uart_rx, uart_drops = struct.unpack("<10I", reply)
if magic != 0x31505348:
    raise SystemExit("Unexpected bridge firmware")
print(json.dumps({"firmware": "Hanshow PIO bridge", "version": f"{version >> 16}.{version & 0xffff}",
    "reset_enabled": bool(flags & 1), "reset_asserted": bool(flags & 2),
    "sws_open": bool(flags & 4), "uart_open": bool(flags & 8),
    "sws_baud": sws_baud, "uart_baud": uart_baud,
    "sws_rx_bytes": sws_rx, "sws_tx_bytes": sws_tx, "sws_dropped_bytes": sws_drops,
    "uart_rx_bytes": uart_rx, "uart_dropped_bytes": uart_drops}, indent=2))
if args.boot:
    device.ctrl_transfer(0x40, 0xB0, 0xB007, 0, b"", timeout=2000)
    print("Requested USB boot mode.")
