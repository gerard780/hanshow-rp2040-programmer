#!/usr/bin/env python3
"""Probe legacy Telink SWS/SPI-compatible chips and take matching flash readbacks.

Uses only the upstream reader's activation, register and read functions. Flash
erase/program/write-enable/unlock functions are never called.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import struct
import time
from pathlib import Path

import serial
import serial.tools.list_ports
import usb.core

from benchmark_readback import checked_write, fast_flash_read, bridge_status

HERE = Path(__file__).resolve().parent
BACKENDS = {
    "825x": (3, "TLSR825xComFlasher.py", "2ea1b7c5266821e5d384a263daa7916bb4020fcdfb8f1ec0bed5842dcb94ca18"),
    "826x": (2, "TLSR826xComFlasher.py", "662ab933d8d97424c140b47a748e859d4453d14edc468c41874fb020ba93bdb0"),
}
MAX_SIZE = 1 << 24  # These SPI reads use three-byte flash addresses.


def load_reader(family):
    width, filename, expected = BACKENDS[family]
    path = HERE / "vendor" / filename
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError(f"Unexpected {family} reader hash")
    spec = importlib.util.spec_from_file_location("reader_" + family, path)
    reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reader)
    return width, reader


def capacity(jedec):
    if len(jedec) != 3 or jedec[0] in (0, 255) or jedec[1] in (0, 255):
        raise RuntimeError("No plausible legacy SPI NOR JEDEC response")
    if not 12 <= jedec[2] <= 30:
        return None  # Nonstandard capacity encoding needs an explicit size.
    return 1 << jedec[2]


def capture_size(requested, detected):
    if requested is None:
        if detected is None:
            raise RuntimeError("Unknown JEDEC capacity; supply --size from the flash datasheet")
        size = detected
    else:
        size = requested
    if not 1 <= size <= MAX_SIZE:
        raise RuntimeError("This backend reads at most 16 MiB with three-byte flash addresses")
    if detected is not None and size > detected:
        raise RuntimeError("Requested read exceeds detected flash capacity")
    return size


def identify(reader, port):
    chips = [reader.sws_read_data(port, 0x7D, 3) for _ in range(2)]
    if any(x is None or len(x) != 3 for x in chips) or chips[0] != chips[1]:
        raise RuntimeError("Chip register reads failed or differ")
    chip = bytes(chips[0])
    if chip in (b"\0" * 3, b"\xff" * 3):
        raise RuntimeError("Inconclusive chip register response")
    ids = []
    for _ in range(2):
        try:
            checked_write(reader, port, 0xB3, [0x80])
            checked_write(reader, port, 0x0D, [0])
            checked_write(reader, port, 0x0C, [0x9F, 0])
            checked_write(reader, port, 0x0D, [0x0A])
            data = reader.sws_read_data(port, 0x0C, 3)
            if data is None or len(data) != 3:
                raise RuntimeError("JEDEC read failed")
            ids.append(bytes(data))
        finally:
            checked_write(reader, port, 0x0D, [1])
            checked_write(reader, port, 0xB3, [0])
    if ids[0] != ids[1]:
        raise RuntimeError("Repeated JEDEC IDs differ")
    detected = capacity(ids[0])
    return dict(chip_register_bytes=chip.hex(), jedec_id=ids[0].hex(),
                detected_flash_bytes=detected)


def read_bytes(reader, port, device, mode, count):
    stream = io.BytesIO()
    if mode == "block":
        fast_flash_read(reader, port, device, stream, count)
    elif not reader.FlashReadBlock(port, stream, 0, count):
        raise RuntimeError("Legacy flash read failed")
    data = stream.getvalue()
    if len(data) != count:
        raise RuntimeError("Incomplete flash read")
    return data


def preflight(reader, port, device, mode, size):
    count = min(size, 4096)
    a = read_bytes(reader, port, device, mode, count)
    b = read_bytes(reader, port, device, mode, count)
    if a != b or a in (bytes(count), b"\xff" * count):
        raise RuntimeError("Repeat-read probe differs or is entirely 00/FF")
    return hashlib.sha256(a).hexdigest()


def select_width(device, family):
    version = bridge_status(device)["version"]
    width = BACKENDS[family][0]
    if version in ("1.1", "1.2", "1.4"):
        if width != 3:
            raise RuntimeError("826x address framing requires public programmer firmware 1.3, 1.5 or 1.6")
        return
    if version not in ("1.3", "1.5", "1.6"):
        raise RuntimeError(f"Unrecognized bridge protocol version {version}")
    reply = bytes(device.ctrl_transfer(0xC0, 0x21, 0, 0, 4, timeout=2000))
    if len(reply) != 4 or struct.unpack("<I", reply)[0] not in (2, 3):
        raise RuntimeError("Invalid SWS address-width response")
    if struct.unpack("<I", reply)[0] != width:
        device.ctrl_transfer(0x40, 0x21, width, 0, b"", timeout=2000)
        reply = bytes(device.ctrl_transfer(0xC0, 0x21, 0, 0, 4, timeout=2000))
    if len(reply) != 4 or struct.unpack("<I", reply)[0] != width:
        raise RuntimeError("Bridge address-width selection did not verify")


def read_baud(version, requested=None):
    if version not in ("1.1", "1.2", "1.3", "1.4", "1.5", "1.6"):
        raise RuntimeError(f"Unrecognized bridge protocol version {version}")
    return requested if requested is not None else (2000000 if version in ("1.4", "1.5", "1.6") else 921600)


def finish(reader, port, device, mode):
    errors = []
    if mode == "block":
        try:
            device.ctrl_transfer(0x40, 0x12, 0, 0, b"", timeout=2000)
        except Exception as error:
            errors.append(str(error))
        time.sleep(0.06)
    port.reset_input_buffer()
    # Try every cleanup operation even if a lost link breaks one echo.
    for address, data in ((None, None), (0x0D, [1]), (0xB3, [0]), (0x6F, [0x22])):
        try:
            ok = (reader.rd_wr_usbcom_blk(port, reader.sws_code_end()) if address is None
                  else reader.rd_sws_wr_addr_usbcom(port, address, bytearray(data)))
            if not ok:
                errors.append("stop" if address is None else hex(address))
        except Exception as error:
            errors.append(str(error))
    port.flush()
    time.sleep(0.05)
    if errors:
        raise RuntimeError("Reset/cleanup did not verify: " + ", ".join(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--bridge-serial", required=True, help="Your RP2040-Zero USB serial ID")
    parser.add_argument("--family", choices=("auto", "825x", "826x"), default="auto",
                        help="Legacy register/framing backend; does not identify an exact MCU model")
    parser.add_argument("--mode", choices=("block", "legacy"), default="block")
    parser.add_argument("--size", type=lambda x: int(x, 0), help="Override auto-size; partial reads are labeled")
    parser.add_argument("--runs", type=int, choices=(2, 3), default=2)
    parser.add_argument("--clock-mhz", type=int, choices=(16, 24, 32, 48), help="Override divider probes")
    parser.add_argument("--activation-ms", type=int, default=3000)
    parser.add_argument("--baud", type=int, choices=(921600, 1500000, 2000000),
                        help="Default: 2000000 on v1.4/v1.5/v1.6; 921600 on older bridges. Fallback: 1500000")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.size is not None and not 1 <= args.size <= MAX_SIZE:
        parser.error("Size must be 1..16777216 bytes")
    if not 1 <= args.activation_ms <= 10000:
        parser.error("Activation must be 1..10000 ms")
    devices = [d for d in usb.core.find(find_all=True, idVendor=0xCAFE, idProduct=0x4012)
               if d.serial_number == args.bridge_serial]
    if len(devices) != 1:
        raise SystemExit("Expected exactly one matching RP2040 programmer")
    device = devices[0]
    baud = read_baud(bridge_status(device)["version"], args.baud)
    ports = [p for p in serial.tools.list_ports.comports()
             if os.path.realpath(p.device).casefold() == os.path.realpath(args.port).casefold()]
    if len(ports) != 1 or ports[0].serial_number != args.bridge_serial:
        raise SystemExit("Serial port does not belong to the selected RP2040 programmer")
    if "if02" in os.path.realpath(args.port) or "Tag UART" in (ports[0].interface or ""):
        raise SystemExit("Select the SWS interface, not the tag UART")
    args.output.mkdir(parents=True, exist_ok=False)
    result = dict(verified=False, port=args.port, baud=baud, attempts=[], runs=[],
                  hardware_scope="Legacy Telink SWS/SPI compatibility probe; exact MCU model unconfirmed")
    families = ("825x", "826x") if args.family == "auto" else (args.family,)
    try:
        for family in families:
            attempt = dict(family=family)
            result["attempts"].append(attempt)
            capture_started = False
            try:
                width, reader = load_reader(family)
                select_width(device, family)
                before = bridge_status(device)
                with serial.Serial(args.port, baud, timeout=0.1, write_timeout=2) as port:
                    try:
                        reader.activate(port, args.activation_ms)
                        clocks = (args.clock_mhz,) if args.clock_mhz else (24, 16, 32, 48)
                        for clock in clocks:
                            if reader.set_sws_speed(port, clock * 1000000):
                                attempt["divider_probe_mhz"] = clock
                                break
                        else:
                            raise RuntimeError("SWS divider probes failed")
                        info = identify(reader, port)
                        size = capture_size(args.size, info["detected_flash_bytes"])
                        attempt.update(info, read_bytes=size, sws_address_bytes=width)
                        attempt["probe_sha256"] = preflight(reader, port, device, args.mode, size)
                        capture_started = True
                        for index in range(args.runs):
                            name = f"flash-{index + 1}.bin"
                            started = time.monotonic()
                            with (args.output / name).open("xb") as stream:
                                if args.mode == "block":
                                    fast_flash_read(reader, port, device, stream, size)
                                elif not reader.FlashReadBlock(port, stream, 0, size):
                                    raise RuntimeError("Legacy capture failed")
                            data = (args.output / name).read_bytes()
                            if len(data) != size or data in (bytes(size), b"\xff" * size):
                                raise RuntimeError("Incomplete or inconclusive full read")
                            result["runs"].append(dict(file=name, bytes=size,
                                sha256=hashlib.sha256(data).hexdigest(),
                                read_seconds=time.monotonic() - started))
                    finally:
                        finish(reader, port, device, args.mode)
                after = bridge_status(device)
                faults = after["sws_faults"] - before["sws_faults"]
                if faults or after["reset_asserted"]:
                    raise RuntimeError("Transport faults or reset still asserted")
                if len({r["sha256"] for r in result["runs"]}) != 1:
                    raise RuntimeError("Full repeated reads differ")
                result.update(verified=True, selected_family=family,
                    detected_flash_bytes=info["detected_flash_bytes"], read_bytes=size,
                    complete_flash=(size == info["detected_flash_bytes"]),
                    transport_faults=faults, reset_echo_verified=True,
                    reset_asserted_at_finish=False)
                break
            except Exception as error:
                attempt["error"] = str(error)
                # Do not reinterpret a failed/mismatched capture as another family.
                if capture_started:
                    raise
                time.sleep(0.1)
        if not result["verified"]:
            raise RuntimeError("No legacy backend passed identification and repeat-read checks")
    except Exception as error:
        result["error"] = str(error)
    finally:
        (args.output / "readback.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
